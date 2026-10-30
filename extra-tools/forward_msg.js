import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)

const MAX_CHARS = 8000
const MAX_DEPTH = 3

const dataOf = seg => (seg?.data && typeof seg.data === 'object' ? seg.data : seg || {})

/**
 * 消息里合并转发的 id：OneBot 为 forward 消息段（NapCat 可能直接带 content），
 * ICQQ 可能是 forward 段，或带 m_resid / resid 的 xml、json 卡片
 */
function forwardOf (m) {
  for (const seg of Array.isArray(m?.message) ? m.message : []) {
    const d = dataOf(seg)
    if (seg?.type === 'forward') return { id: d.id ?? d.resid, content: d.content }
    const raw = typeof d.data === 'string' ? d.data : ''
    if (seg?.type === 'xml' || seg?.type === 'json') {
      const resid = raw.match(/m_resid="([^"]+)"/)?.[1] || raw.match(/"resid"\s*:\s*"([^"]+)"/)?.[1]
      if (resid) return { id: resid }
    }
  }
  return null
}
const isForward = m => !!forwardOf(m)

/** 读出合并转发里的消息：ICQQ 的 getForwardMsg，OneBot 的 get_forward_msg */
async function load (bot, fwd) {
  if (Array.isArray(fwd.content) && fwd.content.length) return fwd.content
  const ret = await chat.invoke([
    [bot, 'getForwardMsg', [fwd.id]],
    [bot, 'sendApi', ['get_forward_msg', { message_id: fwd.id, id: fwd.id }]]
  ], '读取合并转发')
  return Array.isArray(ret) ? ret : ret?.messages || ret?.message || []
}

const SEG_TEXT = { image: '[图片]', face: '[表情]', mface: '[表情]', record: '[语音]', video: '[视频]', file: '[文件]', json: '[卡片]', xml: '[卡片]' }

/** 展开成文字，嵌套的转发往里缩进（最多 3 层） */
async function render (bot, nodes, depth, out) {
  for (const node of nodes) {
    if (out.chars > MAX_CHARS) return
    const d = dataOf(node)
    const name = d.nickname || d.sender?.card || d.sender?.nickname || d.name || d.user_id || d.uin || '?'
    const time = Number(d.time) > 0 ? chat.beijing(Number(d.time) * 1000, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
    const segs = d.message ?? d.content ?? []
    const parts = []
    const nested = []
    for (const seg of Array.isArray(segs) ? segs : [segs]) {
      if (typeof seg !== 'object' || !seg) {
        parts.push(String(seg ?? ''))
        continue
      }
      const sd = dataOf(seg)
      if (seg.type === 'text') parts.push(sd.text ?? '')
      else if (seg.type === 'at') parts.push(`@${sd.qq ?? ''} `)
      else if (seg.type === 'forward' || seg.type === 'node') {
        parts.push('[聊天记录]')
        nested.push({ id: sd.id ?? sd.resid, content: sd.content })
      } else parts.push(SEG_TEXT[seg.type] ?? `[${seg.type}]`)
    }
    const line = `${'  '.repeat(depth)}${time ? `[${time}] ` : ''}${name}：${parts.join('').replace(/\s+/g, ' ').trim()}`
    out.lines.push(line)
    out.chars += line.length
    out.count++
    for (const fwd of nested) {
      if (depth + 1 >= MAX_DEPTH) continue
      try {
        await render(bot, await load(bot, fwd), depth + 1, out)
      } catch (err) {
        out.lines.push(`${'  '.repeat(depth + 1)}（这段聊天记录读不出来：${err.message}）`)
      }
    }
  }
}

export class ForwardMsgTool extends CustomTool {
  name = 'forward_msg'

  function = {
    name: 'forward_msg',
    description: '读取合并转发的聊天记录（群聊的聊天记录卡片）的完整内容，嵌套的聊天记录也会展开。' +
      '用户引用一条聊天记录让你总结、看看说了什么时调用（工具会自己读取引用，看不到内容也直接调用）；没有引用时读群里最近的一条聊天记录。需要同群的野生号。',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '拿不到当前消息'
    try {
      let bot, m
      if (e.isGroup || e.group_id) {
        const gid = String(e.group_id)
        bot = grp.wildFor(e, gid)
        if (!bot) return '这个群里没有野生号，官方机器人读不到合并转发的内容'
        m = e.source
          ? await chat.quotedMessage(e, bot, gid, { filter: isForward })
          : (await chat.recentMessages(e, bot, gid, { filter: isForward }))[0]
        if (!m) return `最近 ${chat.SCAN} 条群消息里没有合并转发的聊天记录`
      } else {
        // 私聊：只有野生号能读，且要引用那条聊天记录
        if (!chat.isWildBot(e.bot)) return '官方机器人在私聊里读不到合并转发的内容'
        bot = e.bot
        m = isForward(e) ? e : await e.getReply?.().catch(() => null)
        if (!m || !isForward(m)) return '请引用要读取的聊天记录'
      }
      const fwd = forwardOf(m)
      if (!fwd) return '引用的那条消息不是合并转发的聊天记录'
      const out = { lines: [], chars: 0, count: 0 }
      await render(bot, await load(bot, fwd), 0, out)
      if (!out.count) return '这段聊天记录是空的，或者已经过期读不出来了'
      const from = m.sender?.card || m.sender?.nickname || chat.senderOf(m)
      return `${from ? `${from} 转发的` : ''}聊天记录（共 ${out.count} 条${out.chars > MAX_CHARS ? '，太长只显示前面一部分' : ''}）：\n${out.lines.join('\n')}`
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new ForwardMsgTool()
