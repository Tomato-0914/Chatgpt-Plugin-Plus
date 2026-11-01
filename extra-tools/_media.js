/**
 * 文件读取（file_read）用的辅助函数：识别文件类型、读音视频信息、截取视频画面、
 * 解析 PDF / Word / Excel / PPT / 压缩包里的文字，把图片交给识图工具。
 * 音视频用服务器上的 ffprobe / ffmpeg（优先用 Yunzai bot.yaml 里配置的路径），PDF 用 pdftotext；
 * 没装时如实说明，不影响其他类型。以 _ 开头，不会被当成工具登记。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const plugin = './plugins/chatgpt-plugin'

/* ---------- 类型识别 ---------- */

const EXT = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'amr', 'wma', 'ape', 'silk', 'slk'],
  video: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'mpg', 'mpeg'],
  word: ['docx'],
  excel: ['xlsx'],
  ppt: ['pptx'],
  zip: ['zip', 'jar', 'apk'],
  pdf: ['pdf']
}

/** 按文件头和扩展名判断类型：text / image / audio / video / pdf / word / excel / ppt / zip / binary */
export function detect (file, head) {
  const ext = path.extname(file).slice(1).toLowerCase()
  const is = (...bytes) => bytes.every((b, i) => head[i] === b)
  if (is(0x25, 0x50, 0x44, 0x46)) return 'pdf'
  if (is(0x89, 0x50, 0x4e, 0x47) || is(0xff, 0xd8, 0xff) || is(0x47, 0x49, 0x46, 0x38) ||
    (is(0x52, 0x49, 0x46, 0x46) && head.subarray(8, 12).toString() === 'WEBP') || is(0x42, 0x4d)) return 'image'
  if (is(0x50, 0x4b, 0x03, 0x04)) {
    for (const type of ['word', 'excel', 'ppt']) if (EXT[type].includes(ext)) return type
    return 'zip'
  }
  for (const type of ['audio', 'video']) if (EXT[type].includes(ext)) return type
  // QQ 语音（silk）、AMR、常见音视频的文件头
  if (head.subarray(0, 10).toString().includes('SILK') || head.subarray(0, 6).toString() === '#!AMR') return 'audio'
  if (is(0x49, 0x44, 0x33) || is(0x4f, 0x67, 0x67, 0x53) || is(0x66, 0x4c, 0x61, 0x43)) return 'audio'
  if (head.subarray(4, 8).toString() === 'ftyp' || is(0x1a, 0x45, 0xdf, 0xa3)) return 'video'
  if (is(0x52, 0x49, 0x46, 0x46) && head.subarray(8, 12).toString() === 'WAVE') return 'audio'
  if (!head.subarray(0, 8192).includes(0)) return 'text'
  return 'binary'
}

/** 文本解码：UTF-8 乱码多时按 GBK 再解一次（Windows 下保存的 txt、bat 常见） */
export function decodeText (buffer) {
  const utf8 = buffer.toString('utf8')
  const bad = (utf8.match(/�/g) || []).length
  if (!bad || bad < utf8.length / 200) return { text: utf8, encoding: 'UTF-8' }
  try {
    return { text: new TextDecoder('gbk').decode(buffer), encoding: 'GBK' }
  } catch {
    return { text: utf8, encoding: 'UTF-8' }
  }
}

/* ---------- 命令行工具 ---------- */

let botCfg
async function binPath (name) {
  try {
    botCfg ??= (await import(pathToFileURL(path.resolve('./lib/config/config.js')).href)).default?.bot || {}
  } catch {
    botCfg = {}
  }
  return botCfg[`${name}_path`] || name
}

function run (bin, args, { timeout = 30000, encoding = 'utf8', maxBuffer = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, encoding, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new Error(`服务器上没有 ${path.basename(bin)}`))
        return reject(new Error(String(stderr || err.message).trim().split('\n').pop()))
      }
      resolve(stdout)
    })
  })
}

/* ---------- 音视频 ---------- */

const duration = s => {
  const t = Math.round(Number(s) || 0)
  if (!t) return ''
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = t % 60
  return h ? `${h} 小时 ${m} 分 ${sec} 秒` : m ? `${m} 分 ${sec} 秒` : `${sec} 秒`
}
const kbps = b => (Number(b) > 0 ? `${Math.round(Number(b) / 1000)} kbps` : '')

/** ffprobe 读出来的信息：{ format, streams } */
export async function probe (file) {
  const out = await run(await binPath('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])
  return JSON.parse(out || '{}')
}

/** 音视频信息转成几行文字；hasVideo 表示有真正的视频流（不是 mp3 里的封面图） */
export function mediaInfo (info) {
  const f = info.format || {}
  const streams = info.streams || []
  const video = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = streams.find(s => s.codec_type === 'audio')
  const tags = { ...(f.tags || {}) }
  const lines = []
  const fmt = String(f.format_long_name || f.format_name || '')
  if (fmt) lines.push(`格式：${fmt}`)
  if (duration(f.duration)) lines.push(`时长：${duration(f.duration)}`)
  if (kbps(f.bit_rate)) lines.push(`总码率：${kbps(f.bit_rate)}`)
  if (video) {
    const fps = String(video.avg_frame_rate || '').split('/').map(Number)
    const rate = fps[1] ? Math.round((fps[0] / fps[1]) * 100) / 100 : 0
    lines.push(`视频：${video.codec_name || ''} ${video.width}×${video.height}${rate ? `，${rate} 帧/秒` : ''}`)
  }
  if (audio) {
    lines.push(`音频：${audio.codec_name || ''}${audio.sample_rate ? `，${audio.sample_rate} Hz` : ''}${audio.channels ? `，${audio.channels === 1 ? '单声道' : audio.channels === 2 ? '立体声' : `${audio.channels} 声道`}` : ''}${kbps(audio.bit_rate) ? `，${kbps(audio.bit_rate)}` : ''}`)
  }
  const tag = k => tags[k] || tags[k.toUpperCase()]
  const meta = [['标题', 'title'], ['艺术家', 'artist'], ['专辑', 'album'], ['日期', 'date'], ['备注', 'comment']]
    .map(([label, key]) => (tag(key) ? `${label}：${tag(key)}` : '')).filter(Boolean)
  if (meta.length) lines.push(...meta)
  return { lines, hasVideo: Boolean(video), duration: Number(f.duration) || 0, width: video?.width, height: video?.height }
}

/** 从视频里均匀截几帧（JPEG，宽最多 640） */
export async function frames (file, seconds, count) {
  const bin = await binPath('ffmpeg')
  const list = []
  for (let i = 0; i < count; i++) {
    // 避开开头和结尾的黑屏：取 (i+0.5)/count 处
    const at = seconds > 0 ? (seconds * (i + 0.5)) / count : 0
    const buf = await run(bin, ['-v', 'error', '-ss', String(at.toFixed(2)), '-i', file, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
      { encoding: 'buffer', timeout: 20000 })
    if (buf?.length) list.push({ at, buffer: buf })
  }
  return list
}

/* ---------- 交给识图工具的图片 ---------- */

let vision
/** 把图片存成工具图片，返回 [工具图片 ref:t_xxx，可使用 look_at_image ...] 这样的标记 */
export async function imageMarker (buffer, source) {
  vision ??= {
    service: (await import(pathToFileURL(path.resolve(plugin, 'utils/vision.js')).href)).visionService,
    marker: (await import(pathToFileURL(path.resolve(plugin, 'utils/image_context.js')).href)).imageRefMarker
  }
  const saved = vision.service.saveImageFromBuffer(buffer, 'image/jpeg', '', { origin: 'tool', source })
  await vision.service.registerTemporaryImage?.({ ref: saved.ref, filePath: saved.filePath }, { source: 'file_read' }).catch?.(() => {})
  return vision.marker(saved.ref)
}

/** 不受识图支持的图片（如 BMP）先用 ffmpeg 转成 JPEG */
export async function toJpeg (file) {
  return await run(await binPath('ffmpeg'), ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
    { encoding: 'buffer', timeout: 20000 })
}

/* ---------- PDF ---------- */

export async function pdfText (file) {
  return await run(await binPath('pdftotext'), ['-layout', '-enc', 'UTF-8', file, '-'], { timeout: 60000 })
}

/* ---------- Office 文档、压缩包（zip） ---------- */

/** zip 里的文件列表（读中央目录） */
export function zipEntries (buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是完整的 zip 文件')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const nameLen = buf.readUInt16LE(off + 28)
    const flags = buf.readUInt16LE(off + 8)
    const raw = buf.subarray(off + 46, off + 46 + nameLen)
    entries.push({
      // 第 11 位为 1 是 UTF-8 文件名，否则多半是 GBK（Windows 下压的中文名）
      name: flags & 0x800 ? raw.toString('utf8') : decodeText(raw).text,
      method: buf.readUInt16LE(off + 10),
      compSize: buf.readUInt32LE(off + 20),
      size: buf.readUInt32LE(off + 24),
      localOff: buf.readUInt32LE(off + 42)
    })
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32)
  }
  return entries
}

/** 解出 zip 里的一个文件 */
export function zipRead (buf, entry) {
  const lo = entry.localOff
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28)
  const data = buf.subarray(start, start + entry.compSize)
  if (entry.method === 0) return data
  if (entry.method === 8) return zlib.inflateRawSync(data)
  throw new Error(`不支持的压缩方式 ${entry.method}`)
}

const entities = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&')
const stripTags = s => entities(s.replace(/<[^>]+>/g, ''))
const numOf = name => Number(name.match(/(\d+)\.xml$/)?.[1] || 0)

/** Word（docx）的正文：一段一行，表格单元格用制表符隔开 */
export function docxText (buf) {
  const entries = zipEntries(buf)
  const doc = entries.find(e => e.name === 'word/document.xml')
  if (!doc) throw new Error('不是 Word 文档（没有 word/document.xml）')
  const xml = zipRead(buf, doc).toString('utf8')
  // 表格：单元格内的段落用空格连，单元格之间用制表符，一行表格一行
  const flat = xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n')
    .replace(/<w:tc[ >][\s\S]*?<\/w:tc>/g, cell => cell.replace(/<\/w:p>/g, ' ').replace(/<\/w:tc>$/, '\t</w:tc>'))
    .replace(/<\/w:tr>/g, '\n').replace(/<\/w:p>/g, '\n')
  return stripTags(flat).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Excel（xlsx）的内容：每个工作表一段，一行一行，单元格用制表符隔开 */
export function xlsxText (buf, maxRows = 500) {
  const entries = zipEntries(buf)
  const get = name => {
    const e = entries.find(x => x.name === name)
    return e ? zipRead(buf, e).toString('utf8') : ''
  }
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => stripTags(m[1]))
  const names = [...get('xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map(m => entities(m[1]))
  const sheets = entries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).sort((a, b) => numOf(a.name) - numOf(b.name))
  const out = []
  sheets.forEach((sheet, i) => {
    const xml = zipRead(buf, sheet).toString('utf8')
    const rows = []
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = []
      for (const c of row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]
        const body = c[2] || ''
        const col = (attrs.match(/r="([A-Z]+)/)?.[1] || '').split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        let text = ''
        if (/t="s"/.test(attrs)) text = shared[Number(v)] ?? ''
        else if (/t="inlineStr"/.test(attrs)) text = stripTags(body)
        else if (v !== undefined) text = entities(v)
        if (col) cells[col - 1] = text
      }
      if (cells.some(x => x)) rows.push(Array.from(cells, x => x ?? '').join('\t'))
      if (rows.length >= maxRows) break
    }
    out.push(`【工作表：${names[i] || `Sheet${i + 1}`}】${rows.length >= maxRows ? `（只取前 ${maxRows} 行）` : ''}\n${rows.join('\n') || '（空）'}`)
  })
  if (!out.length) throw new Error('不是 Excel 表格（没有工作表）')
  return out.join('\n\n')
}

/** PPT（pptx）的文字：每页一段 */
export function pptxText (buf) {
  const entries = zipEntries(buf)
  const slides = entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => numOf(a.name) - numOf(b.name))
  if (!slides.length) throw new Error('不是 PPT 演示文稿（没有幻灯片）')
  return slides.map((s, i) => {
    const xml = zipRead(buf, s).toString('utf8')
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map(p => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(t => entities(t[1])).join(''))
      .filter(Boolean)
    return `【第 ${i + 1} 页】\n${paras.join('\n') || '（没有文字）'}`
  }).join('\n\n')
}

/** 压缩包里的文件列表 */
export function zipList (buf, limit = 200) {
  const entries = zipEntries(buf)
  const fmt = n => (n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`)
  const lines = entries.slice(0, limit).map(e => `${e.name}${e.name.endsWith('/') ? '' : `（${fmt(e.size)}）`}`)
  return `共 ${entries.length} 项${entries.length > limit ? `，列出前 ${limit} 项` : ''}：\n${lines.join('\n')}`
}

/** 是否为可以读取的普通文件 */
export const isFile = file => fs.existsSync(file) && fs.statSync(file).isFile()
