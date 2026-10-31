/**
 * 风险操作的确认（分两级）
 *
 * - 主人级（master）：shell、机器人账号、给别人 / 别的群发消息等，只有主人能执行、能批准
 * - 群管级（manager）：入群申请、禁言、踢人、精华、群文件等群内管理，主人和本群的群主、管理员都能执行、能批准
 *
 * 有权限的人发起时直接执行；其他人发起时不执行，先 @ 第一个主人发一条申请（官方机器人发 Markdown + 按钮，野生号发文字）：
 *   - 回复「#确认」/「yes」/「Y」执行，「#拒绝」/「no」/「N」作废（不区分大小写）
 *   - 处理哪一条：点按钮就是按钮所在的那条（按钮带着申请编号）；引用某条申请回复就是被引用的那条；
 *     不引用时只有一条待处理才处理它，有多条时提示引用或点按钮，不猜
 *   - 申请一直有效，直到有权限的人处理；没有权限的人点按钮、回复 Y / N 都无效（不处理，申请照旧有效）；
 *     处理过的申请再点、再回复只会提示已经处理过，不会重复执行
 *   - 按钮在 QQ 里只有有权限的人能点：主人级只给主人；群管级用 QQ 自带的「仅管理者」（群主、管理员），
 *     有主人不是本群群管时再加一行只给主人的按钮，绝不放给所有人
 * 主人按云崽的规则判定：other.yaml 的 master 里当前机器人名下的账号（e.isMaster），masterQQ 不算。
 * 执行的内容在申请时就已经确定，确认时不能被换成别的。申请存在内存里，重启后失效。
 * 确认命令由 apps/extraTools.js 处理。以 _ 开头，不会被当成工具登记。
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const grp = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_group.js')).href)

const state = (globalThis[Symbol.for('chatgpt-extra-tools-approval')] ??= { pending: new Map(), done: new Map() })
// 热重载前的旧版本这里是一个 Map
if (state instanceof Map) globalThis[Symbol.for('chatgpt-extra-tools-approval')] = { pending: new Map(), done: new Map() }
const { pending, done } = globalThis[Symbol.for('chatgpt-extra-tools-approval')]
/** 已处理的申请记多少条（用来提示“已经处理过了”） */
const MAX_DONE = 300

let cfg
/** 当前机器人的主人（other.yaml 的 master 里 机器人账号:主人账号，和云崽的 e.isMaster 一致） */
async function masters (e) {
  cfg ??= (await import(pathToFileURL(path.resolve('./lib/config/config.js')).href)).default
  return [...new Set((cfg.master?.[e?.self_id] || []).map(String))].filter(id => id && id !== 'stdin')
}

/** 主人列表（第一个为主要的主人，申请时 @ 他） */
export const masterList = e => masters(e)

/** 某个账号是不是主人（工具里判断操作对象是不是主人时用） */
export async function isMaster (e, userId) {
  return (await masters(e)).includes(String(userId))
}

const isGroupAdmin = role => role === 'owner' || role === 'admin'

/** 发消息的人在群里能不能做群管级操作：主人，或本群的群主、管理员 */
export async function isManager (e) {
  if (e?.isMaster) return true
  if (!e?.isGroup && !e?.group_id) return false
  return isGroupAdmin(await grp.requesterRole(e))
}

/** 有没有权限直接执行 */
const allowed = (e, level) => (level === 'manager' ? isManager(e) : !!e?.isMaster)

/** 申请所在的聊天：群聊按群号，私聊统一为 private（主人在任意私聊里都能确认私聊发起的申请） */
const chatOf = e => (e?.isGroup || e?.group_id ? `group:${e.group_id}` : 'private')

const asId = id => (/^\d+$/.test(id) ? Number(id) : id)

/** 申请内容（群友说的话）放进 Markdown 前转义会变成格式的字符，换行改成空格（都在行中间，括号、# 等不影响） */
const md = text => String(text ?? '').replace(/([\\`*_[\]~|])/g, '\\$1').replace(/\s*\n\s*/g, ' ')

function newId () {
  let id
  do id = crypto.randomBytes(3).toString('hex')
  while (pending.has(id) || done.has(id))
  return id
}

/** 主人里不是本群群主、管理员的（点不了「仅管理者」按钮，要单独给一行）；拿不到群成员名单时当作都不是 */
async function mastersNotAdmin (e, list) {
  try {
    const admins = new Set((await grp.members(e.group)).filter(m => isGroupAdmin(m.role)).map(m => String(m.user_id)))
    return admins.size ? list.filter(id => !admins.has(id)) : list
  } catch {
    return list
  }
}

/**
 * 官方机器人的确认 / 拒绝按钮（野生号发按钮会报错，不发）。
 * 主人级只给主人点；群管级第一行用 QQ 自带的「仅管理者」权限（admin，QQ 自己判定群主、管理员，
 * 不需要他们绑定 QQ 号——指定用户的名单要换成 openid，没绑定的管理员换不了，会点不了），
 * 有主人不是本群群管时再加一行只给主人的按钮。
 * QQBot-Plugin 的回调按钮 5 分钟后失效，指令同时写进 action.data，超时、重启后点击照样发出指令。
 * 点过的按钮在 QQ 里只显示自己点过，点了「确认」再点「拒绝」不能显示成已确认，所以点后都显示「已处理」，结果看回复
 */
function buttons (e, id, rows) {
  if (e.bot?.adapter?.id !== 'QQBot' || typeof globalThis.segment?.button !== 'function') return []
  const button = (text, cmd, permission) => ({ text, clicked_text: '已处理', callback: cmd, permission, QQBot: { action: { data: cmd } } })
  const out = rows.filter(r => r.permission === 'admin' || r.permission.length)
    .map(r => [button(`✅ 确认${r.tag}`, `#确认 ${id}`, r.permission), button(`❌ 拒绝${r.tag}`, `#拒绝 ${id}`, r.permission)])
  return out.length ? [globalThis.segment.button(...out)] : []
}

/** 按钮的行：[{ permission, tag }] */
async function buttonRows (e, level, list) {
  if (level !== 'manager') return [{ permission: list.map(asId), tag: '' }]
  const extra = await mastersNotAdmin(e, list)
  return [{ permission: 'admin', tag: '' }, ...(extra.length ? [{ permission: extra.map(asId), tag: '（主人）' }] : [])]
}

/** 发送结果里的消息 ID（官方机器人是数组，野生号是一个；ICQQ 还有 seq），用来对应引用回复 */
function sentIds (ret) {
  const ids = []
  for (const r of Array.isArray(ret) ? ret : [ret]) {
    if (!r || typeof r !== 'object') continue
    for (const v of [r.message_id, r.seq].flat()) if (v !== undefined && v !== null && v !== '') ids.push(String(v))
  }
  return ids
}

/** 这条消息引用的消息 ID：野生号的 reply 消息段、e.reply_id，官方机器人的 source.seq */
function quotedIds (e) {
  const ids = []
  for (const seg of Array.isArray(e.message) ? e.message : []) if (seg?.type === 'reply') ids.push(seg.id ?? seg.data?.id)
  ids.push(e.reply_id, e.source?.message_id, e.source?.seq)
  return ids.filter(v => v !== undefined && v !== null && v !== '').map(String)
}

/**
 * 执行风险操作：有权限的人直接执行并返回结果；其他人改为发申请
 * @param {*} e 当前消息
 * @param {{ title: string, run: () => Promise<string>, level?: 'master' | 'manager' }} action
 *   title 写清楚要做什么，run 返回执行结果；level 默认主人级
 * @returns {Promise<string>} 返回给 AI 的文字
 */
export async function guard (e, { title, run, level = 'master' }) {
  if (level === 'manager' && !e?.isGroup && !e?.group_id) level = 'master'
  if (await allowed(e, level)) return await run()
  const list = await masters(e)
  if (!list.length) return '没有配置主人，这个操作只能由主人执行'
  const id = newId()
  const requester = `${e.sender?.card || e.sender?.nickname || ''}(${e.user_id})`
  const item = { id, title, run, level, requester, chat: chatOf(e), group_id: e.group_id, created: Date.now(), msgIds: [] }
  pending.set(id, item)

  const who = level === 'manager' ? '主人或本群群主 / 管理员' : '主人'
  const head = level === 'manager' ? '【需要确认】' : '【需要主人确认】'
  const text = `${head}${requester} 想让我：${title}\n${who}引用这条消息回复「#确认」或 Y 执行，「#拒绝」或 N 取消`
  try {
    const first = asId(list[0])
    let ret
    if (e.isGroup || e.group_id) {
      const btn = buttons(e, id, await buttonRows(e, level, list))
      // 官方机器人发 Markdown（带按钮），野生号发普通文字
      const body = btn.length
        ? { type: 'markdown', data: `\n**${head}**\n> 申请人：${md(requester)}\n> 操作：${md(title)}\n\n${who}点按钮，或引用这条消息回复「#确认」/ Y 执行、「#拒绝」/ N 取消` }
        : ` ${text}`
      ret = await e.reply([{ type: 'at', qq: first }, body, ...btn])
    } else {
      const friend = globalThis.Bot?.pickFriend?.(first)
      ret = typeof friend?.sendMsg === 'function' ? await friend.sendMsg(text) : await e.reply(text)
    }
    item.msgIds = sentIds(ret)
  } catch (err) {
    pending.delete(id)
    return `通知${who}失败（${err.message}），操作没有执行`
  }
  return `这个操作需要${who}确认，已经发了申请，确认后会自动执行。告诉用户等${who}确认即可，不要自己再执行一次`
}

/** 能不能处理这条申请：主人级要主人；群管级要主人，或申请所在群的群主、管理员 */
async function canDecide (e, item) {
  // 官方机器人的按钮点击：QQ 已经按按钮的权限（仅管理者 / 指定的主人）放行；点击事件里没有群身份，
  // 没绑定 QQ 号的管理员也查不到身份，这里直接认可。手打的同样指令是普通消息，不算
  if (isButtonClick(e)) return true
  if (e?.isMaster) return true
  if (item.level !== 'manager') return false
  return String(e.group_id) === String(item.group_id) && isGroupAdmin(await grp.requesterRole(e))
}

/** QQBot-Plugin 把按钮点击转成的消息事件（sub_type 为 callback，带着原始的互动事件） */
const isButtonClick = e => e?.bot?.adapter?.id === 'QQBot' && e.sub_type === 'callback' && Boolean(e.raw?.data?.resolved)

function finish (item, text) {
  pending.delete(item.id)
  done.set(item.id, { msgIds: item.msgIds, text })
  while (done.size > MAX_DONE) done.delete(done.keys().next().value)
}

/**
 * 确认或拒绝
 * @param {*} e 回复的消息（点按钮也是一条带申请编号的消息）
 * @param {boolean} approve
 * @param {string} [id] 按钮带的申请编号
 * @returns {Promise<string|null>} 要回复的文字；和申请无关、或没有权限时返回 null（消息照常交给其他插件）
 */
export async function decide (e, approve, id) {
  const chat = chatOf(e)
  const quoted = quotedIds(e)
  let item
  if (id) {
    id = String(id).toLowerCase()
    item = pending.get(id)
    if (!item) {
      if (!(await isManager(e))) return null
      return done.has(id) ? '这条申请已经处理过了' : '这条申请已经失效（机器人重启过），请重新发起'
    }
    if (item.chat !== chat) return null
  } else if (quoted.length) {
    item = [...pending.values()].find(i => i.msgIds.some(m => quoted.includes(m)))
    if (!item) {
      const old = [...done.values()].find(d => d.msgIds.some(m => quoted.includes(m)))
      return old && (await isManager(e)) ? '这条申请已经处理过了' : null
    }
  } else {
    const mine = []
    for (const i of pending.values()) if (i.chat === chat && await canDecide(e, i)) mine.push(i)
    if (!mine.length) return null
    if (mine.length > 1) return `这里有 ${mine.length} 条待确认的申请，请引用要处理的那条回复，或点它下面的按钮`
    item = mine[0]
  }
  // 没有权限：无效，不处理，申请照旧有效
  if (!(await canDecide(e, item))) return null

  // 没绑定 QQ 号的管理员点按钮时只有 openid
  const by = /^\d{5,12}$/.test(String(e.user_id)) ? `${e.sender?.card || e.sender?.nickname || ''}(${e.user_id})` : (e.sender?.card || e.sender?.nickname || '管理员')
  if (!approve) {
    finish(item, 'rejected')
    return `${by} 已拒绝 ${item.requester} 的请求：${item.title}`
  }
  finish(item, 'approved')
  try {
    return `${by} 已确认 ${item.requester} 的请求：${item.title}\n${await item.run()}`
  } catch (err) {
    return `执行失败：${err.message}`
  }
}

export const list = () => [...pending.values()]
