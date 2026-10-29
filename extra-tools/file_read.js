import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const ws = await import(pathToFileURL(path.resolve(dir, '_workspace.js')).href)
const { redact } = await import(pathToFileURL(path.resolve(dir, '_redact.js')).href)

export class FileReadTool extends CustomTool {
  name = 'file_read'

  function = {
    name: 'file_read',
    description: '查看文本文件的内容，带行号。文件较长时用 offset、limit 分段读取。' +
      'root=yunzai 可以查看框架里的文件（仅主人），其中的密钥、密码会显示为 ***，不能据此修改密钥。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对根目录的文件路径，如 notes/todo.txt 或 plugins/miao-plugin/config/cfg.yaml'
        },
        offset: {
          type: 'number',
          description: '从第几行开始读，默认 1'
        },
        limit: {
          type: 'number',
          description: '最多读多少行，默认 200'
        },
        root: ws.ROOT_PARAM
      },
      required: ['path']
    }
  }

  async run (args, context) {
    try {
      const s = ws.scope(context?.getEvent?.(), args.root)
      const file = ws.resolvePath(args.path, s)
      const name = ws.display(file, s)
      if (!fs.existsSync(file)) return `文件不存在：${name}`
      const stat = fs.statSync(file)
      if (stat.isDirectory()) return `${name} 是目录，请用 file_list 查看`
      if (stat.size > ws.LIMITS.read) return `文件有 ${ws.formatSize(stat.size)}，超过 ${ws.formatSize(ws.LIMITS.read)}，无法直接查看`
      const buffer = fs.readFileSync(file)
      if (ws.isBinary(buffer)) return `${name} 是二进制文件（${ws.formatSize(stat.size)}），无法查看内容`

      // 框架里的文件先打码，密钥不交给 AI
      const content = s.yunzai ? redact(buffer.toString('utf8')) : buffer.toString('utf8')
      const lines = content.split(/\r?\n/)
      const offset = Math.max(Math.floor(Number(args.offset) || 1), 1)
      const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 200), 1), 1000)
      if (offset > lines.length) return `文件只有 ${lines.length} 行`
      const end = Math.min(offset + limit - 1, lines.length)
      const width = String(end).length
      const body = lines.slice(offset - 1, end).map((line, i) => `${String(offset + i).padStart(width)}| ${line}`).join('\n')
      const more = end < lines.length ? `\n（共 ${lines.length} 行，还有 ${lines.length - end} 行，从 offset=${end + 1} 继续读取）` : ''
      const masked = s.yunzai && content.includes('***') ? '\n（*** 是打码的密钥，修改时不要动这些行）' : ''
      return `${name}（第 ${offset}-${end} 行，共 ${lines.length} 行）：\n${body}${more}${masked}`
    } catch (err) {
      return ws.errorText(err)
    }
  }
}

export default new FileReadTool()
