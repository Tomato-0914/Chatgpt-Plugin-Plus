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
async function getMsg (bot, gid, id) {
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
