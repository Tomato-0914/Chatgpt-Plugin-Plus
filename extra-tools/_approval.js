/**
 * 风险操作的主人确认
 *
 * 主人发起的操作直接执行；其他人发起时不执行，生成一个确认码并 @ 主人：
 * 主人回复「#确认 码」才执行，「#拒绝 码」或 5 分钟内没有确认则作废。确认码只对应这一次的具体操作，
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

function newCode () {
  let code
  do code = crypto.randomBytes(3).toString('hex').slice(0, 4)
  while (pending.has(code))
  return code
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
  const code = newCode()
  const requester = `${e.sender?.card || e.sender?.nickname || ''}(${e.user_id})`
  pending.set(code, { code, title, run, requester, user_id: e.user_id, group_id: e.group_id, expires: Date.now() + TTL })
  setTimeout(() => pending.delete(code), TTL).unref?.()

  const text = `【需要主人确认】${requester} 想让我：${title}\n回复「#确认 ${code}」执行，「#拒绝 ${code}」取消，5 分钟内有效`
  try {
    if (e.isGroup || e.group_id) {
      await e.reply([...list.slice(0, 3).flatMap(qq => [{ type: 'at', qq: /^\d+$/.test(qq) ? Number(qq) : qq }, ' ']), text])
    } else if (typeof globalThis.Bot?.sendMasterMsg === 'function') {
      await globalThis.Bot.sendMasterMsg(text)
    } else {
      await e.reply(text)
    }
  } catch (err) {
    pending.delete(code)
    return `通知主人失败（${err.message}），操作没有执行`
  }
  return `这个操作需要主人确认，已经通知主人（确认码 ${code}），主人确认后会自动执行。告诉用户等主人确认即可，不要自己再执行一次`
}

/** 主人确认或拒绝；返回要回复的文字 */
export async function decide (code, approve) {
  const item = pending.get(String(code).toLowerCase())
  if (!item || item.expires < Date.now()) return `没有找到确认码 ${code}，可能已经过期或处理过了`
  pending.delete(item.code)
  if (!approve) return `已拒绝 ${item.requester} 的请求：${item.title}`
  try {
    return `已执行 ${item.requester} 的请求：${item.title}\n${await item.run()}`
  } catch (err) {
    return `执行失败：${err.message}`
  }
}

export const list = () => [...pending.values()].filter(item => item.expires >= Date.now())
