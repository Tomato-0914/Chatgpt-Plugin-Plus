import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)

/** 常用 QQ 表情的名字 → 表情编号 */
const FACES = { 赞: 76, 点赞: 76, 爱心: 66, 玫瑰: 63, doge: 179 }

/**
 * 表情：QQ 表情编号（数字），或一个 emoji 字符（按码点，如 👍 → 128077）
 * @returns {{ id: string, type: number, label: string }} type 1 为 QQ 表情、2 为 emoji
 */
function parseEmoji (input) {
  const text = String(input ?? '').trim() || '👍'
  if (FACES[text.toLowerCase()]) return { id: String(FACES[text.toLowerCase()]), type: 1, label: text }
  if (/^\d{1,4}$/.test(text)) return { id: text, type: 1, label: `QQ 表情 ${text}` }
  if (/^\d{5,6}$/.test(text)) return { id: text, type: 2, label: String.fromCodePoint(Number(text)) }
  const cp = text.codePointAt(0)
  if (cp > 0x2000) return { id: String(cp), type: 2, label: String.fromCodePoint(cp) }
  throw new Error(`不认识的表情：${text}（请用 emoji 字符或 QQ 表情编号）`)
}

/** 要回应的消息：引用的那条 → 指定的人最近一条 → 当前这条（说话的人自己的） */
async function target (e, bot, gid, userId) {
  if (e.source) return await chat.quotedMessage(e, bot, gid)
  if (userId) {
    const uid = await chat.realQQ(e, userId)
    if (!uid) throw new Error('这个用户还没有绑定 QQ 号，找不到他的消息')
    const [m] = await chat.recentMessages(e, bot, gid, { users: [uid] })
    if (!m) throw new Error(`最近 ${chat.SCAN} 条群消息里没有 ${uid} 发的消息`)
    return m
  }
  return await chat.currentMessage(e, bot, gid)
}

/** 贴表情：ICQQ 用群对象的 setReaction（按 seq），OneBot 用 set_msg_emoji_like（按 message_id） */
async function react (bot, gid, m, emoji, set) {
  const group = bot.pickGroup(Number(gid))
  const seq = m.seq ?? m.message_seq
  const calls = []
  if (chat.isWildBot(bot) && bot.adapter?.name === 'ICQQ' && seq !== undefined) {
    calls.push([group, set ? 'setReaction' : 'delReaction', [seq, Number(emoji.id), emoji.type]])
  }
  calls.push([bot, 'sendApi', ['set_msg_emoji_like', { message_id: m.message_id, emoji_id: emoji.id, set }]])
  await chat.invoke(calls, '表情回应')
}

export class EmojiReactionTool extends CustomTool {
  name = 'emoji_reaction'

  function = {
    name: 'emoji_reaction',
    description: '给群消息贴表情回应（由同群的野生号贴）：给说话的人这条消息、引用的那条消息、或某人最近一条消息贴表情（add），也可以取消（remove）。' +
      '工具会自己读取引用的消息，看不到引用内容也直接调用。想表达赞同、喜欢、哈哈等态度时可以用；表情传一个 emoji 字符（如 👍 ❤️ 😂 🎉）或 QQ 表情编号。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove'],
          description: 'add=贴表情（默认）；remove=取消贴过的表情'
        },
        emoji: {
          type: 'string',
          description: '一个 emoji 字符或 QQ 表情编号，默认 👍；也可以写 赞、爱心、玫瑰、doge'
        },
        user_id: {
          type: 'string',
          description: '给这个人最近发的一条消息贴；不填且没有引用时贴在当前说话的人这条消息上'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '拿不到当前消息'
    if (!e.isGroup && !e.group_id) return '只能在群里贴表情'
    try {
      const gid = String(e.group_id)
      const bot = grp.wildFor(e, gid)
      if (!bot) return '这个群里没有野生号，官方机器人不能贴表情回应'
      const emoji = parseEmoji(args.emoji)
      const set = args.action !== 'remove'
      const m = await target(e, bot, gid, String(args.user_id ?? '').replace(/^@/, '').trim())
      await react(bot, gid, m, emoji, set)
      const who = m.sender?.card || m.sender?.nickname || chat.senderOf(m)
      return `已${set ? '给' : '取消'} ${who} 的消息「${chat.textOf(m).slice(0, 20) || '…'}」${set ? '贴上' : '上的'} ${emoji.label}，不需要再重复`
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new EmojiReactionTool()
