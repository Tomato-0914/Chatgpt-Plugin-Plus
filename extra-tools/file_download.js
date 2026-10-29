import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const ws = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_workspace.js')).href)

/** 文件名没有扩展名时按内容类型补上 */
const EXT = {
  'text/html': '.html',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4'
}

/** 从响应头或网址里取文件名，去掉不能用作文件名的字符 */
function guessName (res, url) {
  const disposition = res.headers.get('content-disposition') || ''
  let name = disposition.match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1] || disposition.match(/filename="?([^";]+)"?/i)?.[1]
  if (name) {
    try { name = decodeURIComponent(name) } catch {}
  } else {
    try { name = decodeURIComponent(path.posix.basename(new URL(res.url || url).pathname)) } catch {}
  }
  name = String(name || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim()
  if (!name || name === '.' || name === '..') name = `download_${Date.now()}`
  const ext = EXT[(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()]
  return ext && !path.extname(name) ? name + ext : name
}

export class FileDownloadTool extends CustomTool {
  name = 'file_download'

  function = {
    name: 'file_download',
    description: '把网络上的文件下载到工作目录，之后可以用 file_read 查看或 file_send 发送。' +
      '主人可以用 root=yunzai 下载到框架目录（如插件目录），覆盖已有文件前会自动备份。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '文件地址，以 http:// 或 https:// 开头'
        },
        path: {
          type: 'string',
          description: '保存路径（相对根目录）；以 / 结尾或不填时按原文件名保存到该目录（默认根目录）'
        },
        root: ws.ROOT_PARAM
      },
      required: ['url']
    }
  }

  async run (args, context) {
    const url = String(args.url || '').trim()
    if (!/^https?:\/\//i.test(url)) return '网址必须以 http:// 或 https:// 开头'
    let tmp
    try {
      const s = ws.scope(context?.getEvent?.(), args.root)
      const target = String(args.path || '').trim()
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) })
      if (!res.ok || !res.body) return `下载失败：HTTP ${res.status}`
      const length = Number(res.headers.get('content-length'))
      if (length > ws.LIMITS.download) return `文件有 ${ws.formatSize(length)}，超过 ${ws.formatSize(ws.LIMITS.download)}，已取消`

      const file = !target || target.endsWith('/')
        ? ws.resolvePath(path.posix.join(target || '.', guessName(res, url)), s)
        : ws.resolvePath(target, s)
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) return `${ws.display(file, s)} 是目录`
      fs.mkdirSync(path.dirname(file), { recursive: true })

      // 先写临时文件，超过大小上限或中途失败时不留下半个文件
      tmp = `${file}.downloading`
      const out = fs.createWriteStream(tmp)
      let size = 0
      try {
        for await (const chunk of Readable.fromWeb(res.body)) {
          size += chunk.length
          if (size > ws.LIMITS.download) throw new Error(`文件超过 ${ws.formatSize(ws.LIMITS.download)}，已取消`)
          if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve))
        }
      } finally {
        await new Promise(resolve => out.end(resolve))
      }
      const backup = s.yunzai ? ws.backup(file) : ''
      fs.renameSync(tmp, file)
      tmp = undefined
      return `已下载到 ${ws.display(file, s)}（${ws.formatSize(size)}）${backup ? '，原文件已备份，可用 file_restore 还原' : ''}`
    } catch (err) {
      return err.name === 'TimeoutError' ? '下载失败：请求超时' : ws.errorText(err)
    } finally {
      if (tmp) fs.rmSync(tmp, { force: true })
    }
  }
}

export default new FileDownloadTool()
