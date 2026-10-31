/**
 * 与聊天、群操作相关的工具共用的辅助函数
 *
 * 官方机器人没有的群操作（戳一戳、点赞、查群员、拉群消息记录等）由 QQBot-Plugin 的野生号辅助代办，
 * 这里照常调用 Yunzai 的群 / 成员 / 好友对象即可。以 _ 开头，不会被当成工具登记。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 发送结果里是否有消息 id（官方机器人失败时返回 { message_id: [], error: [...] }） */
export function sent (ret) {
  if (!ret) return false
  if (Array.isArray(ret.message_id)) return ret.message_id.length > 0
  return ret.message_id != null && ret.message_id !== ''
}

/** 发送失败的原因 */
export const failReason = ret => ret?.error?.[0]?.message || ret?.error?.[0] || '没有返回消息 ID'

/** 工具参数里的用户 id，不填时为当前发消息的人；去掉 @ 和空白 */
export function targetUser (e, id) {
  const value = String(id ?? '').replace(/^@/, '').trim()
  return value || String(e.user_id)
}

/** QQ 号写成数字，openid 等保持字符串 */
export const asId = id => (/^\d{5,12}$/.test(String(id)) ? Number(id) : id)

/** QQBot-Plugin 的 QQ 号 → openid 映射模块（lib/uinMap.js）；没装 QQBot-Plugin 时为 null */
let uinMap
async function qqbotUinMap () {
  if (uinMap !== undefined) return uinMap
  uinMap = null
  try {
    for (const dir of fs.readdirSync(path.resolve('./plugins'))) {
      const file = path.resolve('./plugins', dir, 'lib/uinMap.js')
      if (!fs.existsSync(file)) continue
      const mod = await import(pathToFileURL(file).href)
      if (typeof mod.getMappedOpenid === 'function' && typeof mod.getAppid === 'function') {
        uinMap = mod
        break
      }
    }
  } catch {}
  return uinMap
}

/**
 * @ 某人的消息段。官方机器人 @ 人要把 QQ 号换成 openid，没有绑定 QQ 号的人换不到，@ 会被丢掉，
 * 这时改成文字“@名字”（real 为 false，对方收不到提醒）
 * @returns {Promise<{ seg: object|string, real: boolean }>}
 */
export async function mention (e, userId, name) {
  const id = String(userId ?? '')
  if (e?.bot?.adapter?.id === 'QQBot' && /^\d{5,12}$/.test(id)) {
    const map = await qqbotUinMap()
    if (map && !(await map.getMappedOpenid(map.getAppid(e.bot), id))) return { seg: `@${name || id} `, real: false }
  }
  return { seg: { type: 'at', qq: asId(id) }, real: true }
}

/** 官方机器人的 openid 换成绑定的 QQ 号；本来就是 QQ 号时原样返回，没绑定时返回空串 */
export async function realQQ (e, userId) {
  const id = String(userId ?? '')
  if (/^\d{5,12}$/.test(id)) return id
  const map = await qqbotUinMap()
  return (map && typeof map.getMappedUin === 'function' && String(await map.getMappedUin(map.getAppid(e?.bot), id) || '')) || ''
}

export const errorText = err => `操作失败：${err?.message || err}`

/** 野生号（OneBotv11 / ICQQ） */
export const isWildBot = bot => ['OneBotv11', 'ICQQ'].includes(bot?.adapter?.name)

/** 在这个群里的野生号（群号必须是真实群号） */
export function wildInGroup (groupId) {
  const gid = Number(groupId)
  if (!gid) return null
  for (const id of globalThis.Bot?.uin || []) {
    const bot = globalThis.Bot[id]
    if (isWildBot(bot) && (bot.gl?.has(gid) || bot.gl?.has(String(gid)))) return bot
  }
  return null
}

/** 北京时间 */
export const beijing = (time, options = {}) =>
  new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, ...options })

/* ---------- 群消息记录（search_chat_history、group_admin 撤回共用） ---------- */

const PAGE = 100
const SEG_TEXT = { image: '[图片]', face: '[表情]', mface: '[表情]', record: '[语音]', video: '[视频]', file: '[文件]', json: '[卡片]', xml: '[卡片]', forward: '[聊天记录]', reply: '' }

/** 群消息记录里的一条消息转成文字 */
export function textOf (msg) {
  if (Array.isArray(msg.message)) {
    return msg.message.map(seg => {
      if (typeof seg !== 'object' || !seg) return String(seg ?? '')
      const data = seg.data && typeof seg.data === 'object' ? seg.data : seg
      if (seg.type === 'text') return data.text ?? ''
      if (seg.type === 'at') return `@${data.qq ?? ''} `
      // 合并转发卡片和官方机器人的引用预览一致，写成 [聊天记录]
      if (seg.type === 'json' && /com\.tencent\.multimsg/.test(typeof data.data === 'string' ? data.data : JSON.stringify(data.data ?? ''))) return SEG_TEXT.forward
      return SEG_TEXT[seg.type] ?? `[${seg.type}]`
    }).join('').replace(/\s+/g, ' ').trim()
  }
  return String(msg.raw_message ?? '').replace(/\s+/g, ' ').trim()
}

/** 用野生号往前翻群消息记录，返回按时间从早到晚排好的消息 */
export async function fetchHistory (bot, groupId, total) {
  const group = bot.pickGroup(Number(groupId))
  if (typeof group?.getChatHistory !== 'function') throw new Error('野生号不支持读取群消息记录')
  const seen = new Map()
  let anchor
  for (let page = 0; page < Math.ceil(total / PAGE); page++) {
    const batch = await group.getChatHistory(anchor, PAGE, true)
    const list = (Array.isArray(batch) ? batch : []).filter(Boolean)
    if (!list.length) break
    let added = 0
    for (const msg of list) {
      const key = msg.message_id ?? `${msg.message_seq}-${msg.time}`
      if (!seen.has(key)) {
        seen.set(key, msg)
        added++
      }
    }
    // 以这一页最早一条消息的序号为锚点，继续往前翻
    const oldest = list.reduce((a, b) => (Number(a.time) <= Number(b.time) ? a : b))
    const next = oldest.message_seq ?? oldest.real_seq ?? oldest.message_id
    if (!added || next === undefined || next === anchor) break
    anchor = next
  }
  return [...seen.values()].sort((a, b) => Number(a.time) - Number(b.time))
}

/* ---------- 在野生号这边找到同一条消息（撤回、精华、表情回应、合并转发共用） ---------- */

/** 默认往前翻多少条群消息 */
export const SCAN = 200
const norm = text => String(text ?? '').replace(/\s+/g, '')

/** 发这条消息的人 */
export const senderOf = m => String(m.user_id ?? m.sender?.user_id ?? '')

/**
 * 官方机器人收到的消息只有发送时间和内容，消息 ID 野生号用不了：到野生号的消息记录里按时间、内容找同一条。
 * filter 用来限定消息类型（如合并转发）；限定了类型时，按内容找不到就取时间最接近的那条
 */
function sameMessage (history, time, text, filter, sender) {
  const near = history
    .filter(m => Math.abs(Number(m.time) - time) <= 120)
    .filter(m => !filter || filter(m))
    .filter(m => !sender || senderOf(m) === sender)
    .sort((a, b) => Math.abs(Number(a.time) - time) - Math.abs(Number(b.time) - time))
  const t = norm(text).slice(0, 20)
  const byText = near.find(m => !t || norm(textOf(m)).includes(t) || t.includes(norm(textOf(m)).slice(0, 20)))
  return byText || (filter ? near[0] : undefined)
}

/** 机器人自己发的消息（请求之后机器人马上发的提示、思考过程等不能算进来） */
const isBotMsg = m => (globalThis.Bot?.uin || []).map(String).includes(senderOf(m))

/**
 * 是不是发起请求的这条消息本身（野生号这边的记录）：同一个人、时间相差 10 秒内、内容包含这条消息的文字。
 * 官方机器人和野生号记录的时间可能差一两秒，不能只按时间排除
 */
function isCurrent (e, m) {
  if (isWildBot(e.bot) && e.message_id && m.message_id === e.message_id) return true
  const cur = norm(e.msg ?? e.raw_message).slice(0, 20)
  if (!cur || senderOf(m) !== String(e.user_id)) return false
  return Math.abs(Number(m.time) - (Number(e.time) || Date.now() / 1000)) <= 10 && norm(textOf(m)).includes(cur)
}

/**
 * 被引用的那条消息（野生号这边的消息对象）；没有引用时返回 null
 * 当前机器人是野生号时直接取引用，官方机器人收到的引用到野生号的消息记录里找。
 * 官方机器人没收到被引用的消息时（没有 @ 机器人的消息收不到），引用信息里的时间是这条请求的时间，
 * 所以只在这条请求之前的消息里找，并排除请求本身
 */
export async function quotedMessage (e, bot, gid, { filter, scan = SCAN } = {}) {
  if (!e.source) return null
  if (isWildBot(e.bot)) {
    const reply = await e.getReply?.().catch(() => null)
    if (reply?.message_id && (!filter || filter(reply))) return reply
  }
  const now = Number(e.time) || Infinity
  const history = (await fetchHistory(bot, gid, scan))
    .filter(m => Number(m.time) < now || (Number(m.time) <= now + 2 && !isBotMsg(m)))
    .filter(m => !isCurrent(e, m))
  const time = Number(e.source.time) || now
  const sender = /^\d{5,12}$/.test(String(e.source.user_id ?? '')) ? String(e.source.user_id) : ''
  const found = (sender && sameMessage(history, time, e.source.message, filter, sender)) || sameMessage(history, time, e.source.message, filter)
  if (!found) throw new Error('没有在群消息记录里找到被引用的那条消息，可能太早了')
  return found
}

/** 当前这条消息（野生号这边的消息对象）：给发消息的人贴表情等用 */
export async function currentMessage (e, bot, gid) {
  if (isWildBot(e.bot) && e.bot === bot && e.message_id) return { message_id: e.message_id, seq: e.seq, time: e.time, user_id: e.user_id, message: e.message }
  const found = sameMessage(await fetchHistory(bot, gid, 50), Number(e.time) || Date.now() / 1000, e.msg ?? e.raw_message)
  if (!found) throw new Error('没有在群消息记录里找到当前这条消息')
  return found
}

/**
 * 最近的几条消息（不含当前这条请求以及之后的消息），从早到晚。
 * 两个机器人记录的时间可能差一两秒，按时间放宽 2 秒，再用 isCurrent 排除请求本身
 * @param {{ users?: string[], keyword?: string, count?: number, filter?: Function, scan?: number }} options
 */
export async function recentMessages (e, bot, gid, { users, keyword, count = 1, filter, scan = SCAN } = {}) {
  const before = Number(e.time) || Infinity
  const kw = String(keyword ?? '').toLowerCase()
  return (await fetchHistory(bot, gid, scan))
    .filter(m => Number(m.time) < before || (Number(m.time) <= before + 2 && !isBotMsg(m)))
    .filter(m => !isCurrent(e, m))
    .filter(m => !users || users.includes(senderOf(m)))
    .filter(m => !kw || textOf(m).toLowerCase().includes(kw))
    .filter(m => !filter || filter(m))
    .slice(-count)
}

/* ---------- 调用野生号的接口 ---------- */

/** 当前机器人是野生号时用它，否则用任意一个在线的野生号（账号设置、好友等与群无关的操作） */
export function anyWild (e) {
  if (isWildBot(e?.bot)) return e.bot
  for (const id of globalThis.Bot?.uin || []) if (isWildBot(globalThis.Bot[id])) return globalThis.Bot[id]
  return null
}

/** 接口返回结果里的错误：OneBot 失败时为 { status: 'failed' } 或 retcode 不为 0，ICQQ 有的方法返回 false */
export function failure (ret) {
  if (ret === false) return '接口返回失败'
  if (ret instanceof Error) return ret.message
  if (ret?.status === 'failed' || (ret?.retcode && Number(ret.retcode) !== 0)) return ret.wording || ret.message || ret.msg || `错误码 ${ret.retcode}`
  return ''
}

/**
 * 依次尝试几种调用方式，第一种存在的执行；都不存在时说明野生号不支持
 * calls: [[对象, 方法名, 参数数组], ...]，最后可以给 [bot, 'sendApi', [action, params]] 走 OneBot 接口
 */
export async function invoke (calls, label = '这个操作') {
  for (const [obj, method, args = []] of calls) {
    if (typeof obj?.[method] !== 'function') continue
    const ret = await obj[method](...args)
    const error = failure(ret)
    if (error) throw new Error(error)
    return ret?.data ?? ret
  }
  throw new Error(`野生号不支持${label}`)
}
