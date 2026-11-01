import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const ws = await import(pathToFileURL(path.resolve(dir, '_workspace.js')).href)
const media = await import(pathToFileURL(path.resolve(dir, '_media.js')).href)
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const { redact } = await import(pathToFileURL(path.resolve(dir, '_redact.js')).href)

/** 文本、文档按行分页显示的大小上限（读进内存的大小，显示仍然分页） */
const TEXT_LIMIT = 5 * 1024 * 1024
const DOC_LIMIT = 30 * 1024 * 1024
/** 聊天里的文件存到工作目录的这个文件夹 */
const CHAT_DIR = 'chat-files'
const MEDIA_SEGS = ['file', 'record', 'video', 'image']
const TYPE_NAME = { text: '文本', image: '图片', audio: '音频', video: '视频', pdf: 'PDF', word: 'Word 文档', excel: 'Excel 表格', ppt: 'PPT 演示文稿', zip: '压缩包', binary: '二进制文件' }

/** 按行分页显示（带行号） */
function paged (name, content, args, header = '') {
  const lines = content.split(/\r?\n/)
  const offset = Math.max(Math.floor(Number(args.offset) || 1), 1)
  const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 200), 1), 1000)
  if (offset > lines.length) return `${name} 只有 ${lines.length} 行`
  const end = Math.min(offset + limit - 1, lines.length)
  const width = String(end).length
  const body = lines.slice(offset - 1, end).map((line, i) => `${String(offset + i).padStart(width)}| ${line}`).join('\n')
  const more = end < lines.length ? `\n（共 ${lines.length} 行，还有 ${lines.length - end} 行，从 offset=${end + 1} 继续读取）` : ''
  return `${name}${header}（第 ${offset}-${end} 行，共 ${lines.length} 行）：\n${body}${more}`
}

/* ---------- 聊天里的文件 ---------- */

const segData = seg => (seg?.data && typeof seg.data === 'object' ? { ...seg, ...seg.data } : seg || {})
const isHttp = v => /^https?:\/\//i.test(String(v ?? ''))
const localPath = v => {
  const p = String(v ?? '').replace(/^file:\/\//, '')
  return p && path.isAbsolute(p) && media.isFile(p) ? p : ''
}

/** 被引用的消息（或当前消息）里第一个文件 / 语音 / 视频 / 图片 */
async function chatSegment (e, source) {
  let msg
  if (source === 'message') {
    msg = { message: e.message }
  } else {
    if (!e.source && !e.reply_id) throw new Error('这条消息没有引用其他消息')
    msg = await e.getReply?.().catch(() => null)
    // 官方机器人没收到被引用的消息时只有预览，到同群野生号的消息记录里找
    const has = m => (Array.isArray(m?.message) ? m.message : []).some(s => MEDIA_SEGS.includes(s?.type))
    if (!has(msg) && e.group_id && !chat.isWildBot(e.bot)) {
      const wild = chat.wildInGroup(e.group_id)
      if (wild) msg = (await chat.quotedMessage(e, wild, Number(e.group_id)).catch(() => null)) || msg
    }
  }
  const seg = (Array.isArray(msg?.message) ? msg.message : []).find(s => MEDIA_SEGS.includes(s?.type))
  if (!seg) throw new Error(`${source === 'message' ? '这条消息' : '被引用的消息'}里没有文件、语音、视频或图片`)
  return seg
}

/** 消息段对应的下载地址或本地路径：消息段自带的，或问协议端要（群文件、语音） */
async function locate (e, seg) {
  const d = segData(seg)
  for (const v of [d.url, d.file, d.path]) {
    if (isHttp(v)) return { url: v }
    if (localPath(v)) return { file: localPath(v) }
  }
  const bot = chat.isWildBot(e.bot) ? e.bot : chat.wildInGroup(e.group_id)
  if (!bot) throw new Error('消息里没有文件地址，这个群也没有能代办的野生号')
  const gid = Number(e.group_id)
  const pick = ret => {
    const r = ret?.data ?? ret
    const v = typeof r === 'string' ? r : r?.url || r?.file || r?.path
    if (isHttp(v)) return { url: v }
    if (localPath(v)) return { file: localPath(v) }
    return null
  }
  const tries = []
  if (seg.type === 'file') {
    const fid = d.fid || d.file_id || d.id
    if (gid) tries.push(() => bot.pickGroup(gid).getFileUrl?.(fid), () => bot.sendApi?.('get_group_file_url', { group_id: gid, file_id: fid, busid: d.busid }))
    else tries.push(() => bot.pickFriend?.(chat.asId(e.user_id))?.getFileUrl?.(fid), () => bot.sendApi?.('get_private_file_url', { user_id: Number(e.user_id), file_id: fid }))
    tries.push(() => bot.sendApi?.('get_file', { file_id: fid, file: d.file }))
  } else if (seg.type === 'record') {
    tries.push(() => bot.sendApi?.('get_record', { file: d.file, file_id: d.file_id, out_format: 'mp3' }))
  } else {
    tries.push(() => bot.sendApi?.(seg.type === 'image' ? 'get_image' : 'get_file', { file: d.file, file_id: d.file_id }))
  }
  for (const t of tries) {
    try {
      const hit = pick(await t())
      if (hit) return hit
    } catch {}
  }
  throw new Error('拿不到这个文件的下载地址（可能已经过期）')
}

/** 把聊天里的文件存进工作目录的 chat-files，返回完整路径 */
async function saveFromChat (e, source) {
  const seg = await chatSegment(e, source)
  const d = segData(seg)
  const where = await locate(e, seg)
  const ext = { record: '.mp3', video: '.mp4', image: '.jpg' }[seg.type] || ''
  let name = String(d.name || d.file_name || d.filename || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim()
  if (!name) {
    const base = where.url ? (() => { try { return path.posix.basename(new URL(where.url).pathname) } catch { return '' } })() : path.basename(where.file)
    name = /\.\w{2,5}$/.test(base) ? base : `${seg.type}_${Date.now()}${ext}`
  }
  const target = ws.resolvePath(path.posix.join(CHAT_DIR, name), ws.WORKSPACE)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (where.file) {
    if (fs.statSync(where.file).size > ws.LIMITS.download) throw new Error(`文件超过 ${ws.formatSize(ws.LIMITS.download)}`)
    fs.copyFileSync(where.file, target)
    return target
  }
  const res = await fetch(where.url, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
  const size = Number(res.headers.get('content-length'))
  if (size > ws.LIMITS.download) throw new Error(`文件有 ${ws.formatSize(size)}，超过 ${ws.formatSize(ws.LIMITS.download)}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > ws.LIMITS.download) throw new Error(`文件超过 ${ws.formatSize(ws.LIMITS.download)}`)
  fs.writeFileSync(target, buf)
  return target
}

/* ---------- 各种类型 ---------- */

async function readMedia (file, name, type, args) {
  let info
  try {
    info = media.mediaInfo(await media.probe(file))
  } catch (err) {
    return `${name}（${TYPE_NAME[type]}）：读不出音视频信息（${err.message}）。QQ 语音（silk）等格式需要协议端转码，从聊天里读时会自动转成 mp3`
  }
  const lines = [`${name}（${info.hasVideo ? '视频' : '音频'}，${ws.formatSize(fs.statSync(file).size)}）`, ...info.lines]
  if (info.hasVideo) {
    const count = Math.min(Math.max(Math.floor(Number(args.frames ?? 3)), 0), 6)
    if (count) {
      try {
        const shots = await media.frames(file, info.duration, count)
        for (const s of shots) lines.push(`第 ${Math.round(s.at)} 秒的画面：${await media.imageMarker(s.buffer, { file: name, at: s.at })}`)
      } catch (err) {
        lines.push(`截取画面失败：${err.message}`)
      }
    }
  }
  lines.push(info.hasVideo
    ? '（想知道画面内容就用 look_at_image 查看上面的画面；声音内容无法转写）'
    : '（只能读出音频信息，说话、歌词等声音内容无法转写成文字）')
  return lines.join('\n')
}

async function readImage (file, name, head) {
  let buffer = fs.readFileSync(file)
  let size = ''
  try {
    const info = media.mediaInfo(await media.probe(file))
    if (info.width) size = `，${info.width}×${info.height}`
  } catch {}
  // BMP 等识图不支持的格式先转成 JPEG
  if (head[0] === 0x42 && head[1] === 0x4d) buffer = await media.toJpeg(file)
  return `${name}（图片${size}，${ws.formatSize(fs.statSync(file).size)}）：${await media.imageMarker(buffer, { file: name })}\n（用 look_at_image 查看图片内容）`
}

async function readDoc (file, name, type, s, args) {
  if (fs.statSync(file).size > DOC_LIMIT) return `${name} 有 ${ws.formatSize(fs.statSync(file).size)}，超过 ${ws.formatSize(DOC_LIMIT)}，无法读取`
  let text
  if (type === 'pdf') {
    text = await media.pdfText(file)
    if (!text.trim()) return `${name}（PDF）里没有可以提取的文字，可能是扫描件（图片）`
  } else {
    const buf = fs.readFileSync(file)
    if (type === 'zip') return `${name}（压缩包）：${media.zipList(buf)}`
    text = type === 'word' ? media.docxText(buf) : type === 'excel' ? media.xlsxText(buf) : media.pptxText(buf)
  }
  return paged(name, s.yunzai ? redact(text) : text, args, `（${TYPE_NAME[type]}）`)
}

export class FileReadTool extends CustomTool {
  name = 'file_read'

  function = {
    name: 'file_read',
    description: '读取文件，自动识别类型：文本、代码、脚本、配置（带行号，长的用 offset、limit 分段）；PDF、Word、Excel、PPT 读出文字；压缩包列出里面的文件；' +
      '图片、视频画面交给 look_at_image 看（视频会均匀截几帧）；音视频读出时长、格式、码率等信息（声音内容无法转写）。' +
      '用户发在聊天里的文件、语音、视频、图片：引用了那条消息就 source=quote，就在当前消息里就 source=message，工具会先存到工作目录的 chat-files 再读。' +
      'root=yunzai 可以查看框架里的文件（仅主人），其中的密钥、密码会显示为 ***，不能据此修改密钥。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对根目录的文件路径，如 notes/todo.txt 或 plugins/miao-plugin/config/cfg.yaml（source 为 quote / message 时不用填）'
        },
        source: {
          type: 'string',
          enum: ['workspace', 'quote', 'message'],
          description: 'workspace=按 path 读工作目录或框架里的文件（默认）；quote=读被引用消息里的文件 / 语音 / 视频 / 图片；message=读当前消息里附带的'
        },
        offset: {
          type: 'number',
          description: '文本、文档从第几行开始读，默认 1'
        },
        limit: {
          type: 'number',
          description: '文本、文档最多读多少行，默认 200'
        },
        frames: {
          type: 'number',
          description: '视频截取几帧画面，默认 3，最多 6，0 为不截'
        },
        root: ws.ROOT_PARAM
      },
      required: []
    }
  }

  async run (args, context) {
    try {
      const e = context?.getEvent?.()
      let s, file
      if (args.source === 'quote' || args.source === 'message') {
        if (!e) return '拿不到当前消息'
        s = ws.WORKSPACE
        file = await saveFromChat(e, args.source)
      } else {
        if (!args.path) return '请提供文件路径；读聊天里的文件用 source=quote（引用的消息）或 source=message（当前消息）'
        s = ws.scope(e, args.root)
        file = ws.resolvePath(args.path, s)
      }
      const name = ws.display(file, s)
      if (!fs.existsSync(file)) return `文件不存在：${name}`
      const stat = fs.statSync(file)
      if (stat.isDirectory()) return `${name} 是目录，请用 file_list 查看`
      const saved = args.source === 'quote' || args.source === 'message' ? `（已存到工作目录 ${name}）\n` : ''

      const fd = fs.openSync(file, 'r')
      const head = Buffer.alloc(Math.min(stat.size, 65536))
      fs.readSync(fd, head, 0, head.length, 0)
      fs.closeSync(fd)
      const type = media.detect(file, head)

      if (type === 'text') {
        if (stat.size > TEXT_LIMIT) return `${saved}${name} 有 ${ws.formatSize(stat.size)}，超过 ${ws.formatSize(TEXT_LIMIT)}，无法直接查看`
        const { text, encoding } = media.decodeText(fs.readFileSync(file))
        // 框架里的文件先打码，密钥不交给 AI
        const content = s.yunzai ? redact(text) : text
        const masked = s.yunzai && content.includes('***') ? '\n（*** 是打码的密钥，修改时不要动这些行）' : ''
        return saved + paged(name, content, args, encoding === 'UTF-8' ? '' : `（${encoding} 编码）`) + masked
      }
      if (type === 'image') return saved + await readImage(file, name, head)
      if (type === 'audio' || type === 'video') return saved + await readMedia(file, name, type, args)
      if (['pdf', 'word', 'excel', 'ppt', 'zip'].includes(type)) return saved + await readDoc(file, name, type, s, args)
      // 认不出的二进制文件：可能是没有扩展名的音视频，试一下 ffprobe
      try {
        const info = media.mediaInfo(await media.probe(file))
        if (info.lines.length > 1) return saved + await readMedia(file, name, info.hasVideo ? 'video' : 'audio', args)
      } catch {}
      return `${saved}${name} 是二进制文件（${ws.formatSize(stat.size)}），无法查看内容`
    } catch (err) {
      return ws.errorText(err)
    }
  }
}

export default new FileReadTool()
