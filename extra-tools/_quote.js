/**
 * 读取被引用的消息（chat_context 的 reply、前置处理器 quote_context 共用）：
 * 发送人、时间、内容，以及它又引用的消息。官方机器人没收到被引用的消息时到同群的其他协议机器人的消息记录里找。
 * 以 _ 开头，不会被当成工具登记。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)

const time = t => (Number(t) > 0 ? chat.beijing(Number(t) * 1000) : '')

/** 卡片消息的标题 / 简介；合并转发卡片返回 forward */
function cardText (data) {
  try {
    const json = typeof data === 'string' ? JSON.parse(data) : data
    if (json?.app === 'com.tencent.multimsg') return 'forward'
    const meta = Object.values(json?.meta || {})[0] || {}
    return [json?.prompt, meta.title, meta.desc].filter(Boolean).join(' ').trim()
  } catch {
    return ''
  }
}

/** 消息段转成给 AI 看的文字 */
export function contentOf (msg, { readable = false } = {}) {
  const segs = Array.isArray(msg?.message) ? msg.message : null
  if (!segs) return String(msg?.raw_message ?? msg?.message ?? '').trim() || '（无文字）'
  const parts = []
  for (const seg of segs) {
    if (!seg || typeof seg !== 'object') {
      parts.push(String(seg ?? ''))
      continue
    }
    const data = seg.data && typeof seg.data === 'object' ? seg.data : seg
    switch (seg.type) {
      case 'text': parts.push(data.text ?? ''); break
      case 'at': parts.push(`@${data.text?.replace(/^@/, '') || data.name || data.qq}(${data.qq}) `); break
      case 'reply': break
      case 'image': parts.push(data.summary && data.summary !== '[图片]' ? `[图片：${data.summary}]` : '[图片]'); break
      case 'face': case 'mface': case 'bface': parts.push(data.summary || data.text ? `[表情：${data.summary || data.text}]` : '[表情]'); break
      case 'file': parts.push(`[文件：${data.name || data.file || ''}${readable ? '，可以用 file_read（source=quote）读取内容' : ''}]`); break
      case 'markdown': parts.push(String(data.content ?? data.data ?? '')); break
      case 'forward': case 'node': parts.push('[合并转发的聊天记录，可以用 forward_msg 工具读取]'); break
      case 'json': case 'xml': {
        const card = cardText(data.data ?? seg.data)
        parts.push(card === 'forward' ? '[合并转发的聊天记录，可以用 forward_msg 工具读取]' : `[卡片${card ? `：${card}` : ''}]`)
        break
      }
      case 'record': parts.push(readable ? '[语音，可以用 file_read（source=quote）读取时长等信息]' : '[语音]'); break
      case 'video': parts.push(readable ? '[视频，可以用 file_read（source=quote）读取信息和画面]' : '[视频]'); break
      default: parts.push(`[${seg.type}]`)
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim() || '（无文字）'
}

/** 发消息的人：名字（QQ），机器人自己的标出来 */
export function senderOf (e, msg) {
  const uid = chat.senderOf(msg)
  const name = msg?.sender?.card || msg?.sender?.nickname || ''
  const bot = uid && grp.botIds(e).has(uid) ? '（机器人自己）' : msg?.sender?.bot || msg?.direction === 'outgoing' ? '（机器人自己）' : ''
  return `${name}${uid ? `（${uid}）` : ''}${bot}` || '未知'
}

/** 这条消息又引用了哪条：reply 消息段，或 source */
function replyIdOf (msg) {
  const seg = (Array.isArray(msg?.message) ? msg.message : []).find(s => s?.type === 'reply')
  return seg ? (seg.id ?? seg.data?.id) : msg?.source?.message_id ?? msg?.source?.seq
}

/** 按消息 ID 取消息：群对象 / 机器人的 getMsg（官方机器人从 QQBot-Plugin 的消息记录取） */
export async function getMsg (bot, gid, id) {
  if (id === undefined || id === null || id === '') return null
  for (const fn of [() => gid && bot?.pickGroup?.(chat.asId(gid))?.getMsg?.(id), () => bot?.getMsg?.(id)]) {
    try {
      const m = await fn()
      if (m && (m.message || m.raw_message)) return m
    } catch {}
  }
  return null
}

/**
 * 被引用的那条消息：e.getReply()（其他协议机器人直接取，官方机器人从消息记录取）；
 * 官方机器人没收到被引用的消息时（没有 @ 机器人的消息收不到）只有预览，再到同群的其他协议机器人的消息记录里找
 */
export async function quoted (e) {
  let m = await e.getReply?.().catch(() => null)
  if (!m && e.reply_id) m = await getMsg(e.bot, e.group_id, e.reply_id)
  const gid = Number(e.group_id)
  if (!chat.isWildBot(e.bot) && gid && (!m?.message_id || !chat.senderOf(m))) {
    const wild = chat.wildInGroup(gid)
    if (wild) m = await chat.quotedMessage(e, wild, gid).catch(() => m) || m
  }
  return m
}

/**
 * 被引用消息的文字说明；readable 为 true 时文件、语音、视频后面提示可以用 file_read 读取
 */
export async function replyText (e, depth, { readable = false } = {}) {
  if (!e.source && !e.reply_id) return '这条消息没有引用其他消息'
  const m = await quoted(e)
  if (!m) return '这条消息引用了别的消息，但没有取到内容（可能太早了，或机器人没收到那条消息）'
  const lines = [`被引用的消息：${senderOf(e, m)}${time(m.time) ? `，${time(m.time)}` : ''}`, contentOf(m, { readable })]

  // 引用链：被引用的消息又引用了别的消息
  const bot = chat.isWildBot(e.bot) ? e.bot : chat.wildInGroup(e.group_id) || e.bot
  const seen = new Set([String(m.message_id ?? '')])
  let cur = m
  for (let i = 1; i <= depth; i++) {
    const id = replyIdOf(cur)
    if (id === undefined || id === null || seen.has(String(id))) break
    seen.add(String(id))
    const next = await getMsg(bot, e.group_id, id)
    if (!next) break
    lines.push('', `它引用的消息（第 ${i} 层）：${senderOf(e, next)}${time(next.time) ? `，${time(next.time)}` : ''}`, contentOf(next))
    cur = next
  }
  return lines.join('\n')
}

/* ---------- 逐段解析（chat_context 的 parse / message） ---------- */

const short = (v, n = 300) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
const sizeText = n => (Number(n) > 0 ? (n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`) : '')

/** 卡片（json）里有用的字段：小程序 / 分享卡片的标题、简介、跳转地址；合并转发的 resid */
function cardDetail (data) {
  let json = data
  try { if (typeof json === 'string') json = JSON.parse(json) } catch { return `卡片（解析不了）：${short(data, 200)}` }
  if (json?.app === 'com.tencent.multimsg') return `合并转发卡片（resid：${json.meta?.detail?.resid || '无'}，用 forward_msg 读取）：${short(json.meta?.detail?.news?.map(n => n.text).join(' / '), 120)}`
  const meta = Object.values(json?.meta || {})[0] || {}
  const url = meta.qqdocurl || meta.jumpUrl || meta.url || ''
  return `卡片（${json?.app || '未知'}）：${[json?.prompt, meta.title, meta.desc].filter(Boolean).map(x => short(x, 120)).join(' | ')}${url ? `，链接：${url}` : ''}`
}

/** 一条消息逐段列出来：文字、@、图片地址、文件名和大小、卡片标题和链接、合并转发编号等 */
export function detailOf (msg) {
  const segs = Array.isArray(msg?.message) ? msg.message : null
  if (!segs) return [`（只有文字记录）${short(msg?.raw_message ?? msg?.message ?? '', 500)}`]
  return segs.map((seg, i) => {
    if (!seg || typeof seg !== 'object') return `${i + 1}. 文字：${short(seg)}`
    const d = seg.data && typeof seg.data === 'object' ? { ...seg, ...seg.data } : seg
    const n = `${i + 1}. `
    switch (seg.type) {
      case 'text': return `${n}文字：${short(d.text, 500)}`
      case 'at': return `${n}@ ${d.text?.replace(/^@/, '') || d.name || ''}（${d.qq}）`
      case 'reply': return `${n}引用了消息（ID：${d.id ?? ''}）`
      case 'image': return `${n}图片：${d.url || d.file || ''}${d.summary && d.summary !== '[图片]' ? `（${d.summary}）` : ''}${sizeText(d.file_size) ? `，${sizeText(d.file_size)}` : ''}`
      case 'face': case 'mface': case 'bface': return `${n}表情：${d.summary || d.text || d.id || ''}`
      case 'record': return `${n}语音：${d.url || d.file || ''}（用 file_read 读取时长等信息）`
      case 'video': return `${n}视频：${d.url || d.file || ''}（用 file_read 读取信息和画面）`
      case 'file': return `${n}文件：${d.name || d.file || ''}${sizeText(d.size || d.file_size) ? `，${sizeText(d.size || d.file_size)}` : ''}${d.fid || d.file_id ? `，ID：${d.fid || d.file_id}` : ''}（用 file_read 读取内容）`
      case 'json': return `${n}${cardDetail(d.data ?? seg.data)}`
      case 'xml': return `${n}XML 卡片：${short(d.data ?? seg.data, 200)}`
      case 'forward': case 'node': return `${n}合并转发（ID：${d.id || d.resid || ''}，用 forward_msg 读取）`
      case 'markdown': return `${n}Markdown：${short(d.content ?? d.data, 500)}`
      case 'button': return `${n}按钮`
      default: return `${n}${seg.type}：${short(JSON.stringify(d), 200)}`
    }
  })
}

/** 消息头：发送人、时间、消息 ID */
export function headOf (e, msg) {
  const id = msg?.message_id ?? msg?.seq ?? ''
  return `${senderOf(e, msg)}${time(msg?.time) ? `，${time(msg.time)}` : ''}${id !== '' ? `，消息 ID：${id}` : ''}`
}
