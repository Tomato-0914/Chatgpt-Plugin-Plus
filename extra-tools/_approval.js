/**
 * 风险操作的主人确认
 *
 * 主人发起的操作直接执行；其他人发起时不执行，先 @ 主人申请确认：
 *   - 主人回复「#确认」/「yes」/「Y」执行，「#拒绝」/「no」/「N」作废（不区分大小写），处理的是当前聊天里最近的一条申请；
 *     5 分钟内没有确认自动作废
 *   - 官方机器人的申请消息带「确认」「拒绝」两个回调按钮，按钮只允许主人点；按钮里带着这条申请的编号，
 *     有多条申请时点哪条的按钮就处理哪条
 * 执行的内容在申请时就已经确定，确认时不能被换成别的。确认命令由 apps/extraTools.js 处理。
 * 以 _ 开头，不会被当成工具登记。
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TTL = 5 * 60 * 1000
const pending = (globalThis[Symbol.for('chatgpt-extra-tools-approval')] ??= new Map())

let cfg
async function masters (e) {
  cfg ??= (await import(pathToFileURL(path.resolve('./lib/config/config.js')).href)).default
  const list = [...(cfg.master?.[e?.self_id] || []), ...(cfg.masterQQ || [])]
  return [...new Set(list.map(String))].filter(id => id && id !== 'stdin')
}

/** 是否为主人（工具里判断操作对象是不是主人时用） */
export async function isMaster (e, userId) {
  return (await masters(e)).includes(String(userId))
}

/** 申请所在的聊天：群聊按群号，私聊统一为 private（主人在任意私聊里都能确认私聊发起的申请） */
const chatOf = e => (e?.isGroup || e?.group_id ? `group:${e.group_id}` : 'private')

const asId = id => (/^\d+$/.test(id) ? Number(id) : id)

function newId () {
  let id
  do id = crypto.randomBytes(3).toString('hex')
  while (pending.has(id))
  return id
}

function prune () {
  for (const [id, item] of pending) if (item.expires < Date.now()) pending.delete(id)
}

/** 官方机器人的确认 / 拒绝按钮，只允许主人点 */
function buttons (e, id, list) {
  if (e.bot?.adapter?.id !== 'QQBot' || typeof globalThis.segment?.button !== 'function') return []
  const permission = list.map(asId)
  return [globalThis.segment.button([
    { text: '✅ 确认', callback: `#确认 ${id}`, permission },
    { text: '❌ 拒绝', callback: `#拒绝 ${id}`, permission }
  ])]
}

/**
 * 执行风险操作：主人直接执行并返回结果；其他人改为申请主人确认
 * @param {*} e 当前消息
 * @param {{ title: string, run: () => Promise<string> }} action title 写清楚要做什么，run 返回执行结果
 * @returns {Promise<string>} 返回给 AI 的文字
 */
export async function guard (e, { title, run }) {
  if (e.isMaster) return await run()
  const list = await masters(e)
  if (!list.length) return '没有配置主人，这个操作只能由主人执行'
  prune()
  const id = newId()
  const requester = `${e.sender?.card || e.sender?.nickname || ''}(${e.user_id})`
  pending.set(id, { id, title, run, requester, chat: chatOf(e), created: Date.now(), expires: Date.now() + TTL })
  setTimeout(() => pending.delete(id), TTL).unref?.()

  const text = `【需要主人确认】${requester} 想让我：${title}\n回复「#确认」或 Y 执行，「#拒绝」或 N 取消，5 分钟内有效`
  try {
    if (e.isGroup || e.group_id) {
      await e.reply([...list.slice(0, 3).flatMap(qq => [{ type: 'at', qq: asId(qq) }, ' ']), text, ...buttons(e, id, list)])
    } else if (typeof globalThis.Bot?.sendMasterMsg === 'function') {
      await globalThis.Bot.sendMasterMsg(text)
    } else {
      await e.reply(text)
    }
  } catch (err) {
    pending.delete(id)
    return `通知主人失败（${err.message}），操作没有执行`
  }
  return '这个操作需要主人确认，已经通知主人，主人确认后会自动执行。告诉用户等主人确认即可，不要自己再执行一次'
}

/**
 * 主人确认或拒绝
 * @param {*} e 主人的消息
 * @param {boolean} approve
 * @param {string} [id] 按钮带的申请编号；不填时处理当前聊天里最近的一条
 * @returns {Promise<string|null>} 要回复的文字；当前聊天没有待确认的申请时返回 null
 */
export async function decide (e, approve, id) {
  prune()
  const chat = chatOf(e)
  let item
  if (id) {
    item = pending.get(String(id).toLowerCase())
    if (!item || item.chat !== chat) return '这条申请已经处理过或过期了'
  } else {
    item = [...pending.values()].filter(i => i.chat === chat).sort((a, b) => b.created - a.created)[0]
    if (!item) return null
  }
  pending.delete(item.id)
  const left = [...pending.values()].filter(i => i.chat === chat).length
  const more = left ? `\n（还有 ${left} 条申请待确认）` : ''
  if (!approve) return `已拒绝 ${item.requester} 的请求：${item.title}${more}`
  try {
    return `已执行 ${item.requester} 的请求：${item.title}\n${await item.run()}${more}`
  } catch (err) {
    return `执行失败：${err.message}${more}`
  }
}

export const list = () => [...pending.values()].filter(item => item.expires >= Date.now())
