/**
 * 风险操作的确认（分三级）
 *
 * - 主人级（master）：shell、机器人账号、给别人 / 别的群发消息等，只有主人能执行、能批准
 * - 群管级（manager）：针对别人的群管理（禁言别人 / 全员禁言、撤回别人的消息、踢别人、入群审批、精华、群文件等），
 *   主人和本群的群主、管理员都能执行、能批准
 * - 本人级（self）：只和发起者自己有关的操作（禁言自己、踢自己、撤回自己的消息等）。谁发起都不直接执行，
 *   先 @ 发起者确认，只有发起者本人能确认 / 取消，其他任何人（包括主人）都不能代为处理
 *
 * 主人级、群管级：有权限的人发起时直接执行；其他人发起时不执行，先 @ 第一个主人发一条申请（官方机器人发 Markdown + 按钮，野生号发文字）：
 *   - 回复「#确认」/「yes」/「Y」执行，「#拒绝」/「no」/「N」作废（不区分大小写）
 *   - 处理哪一条：点按钮就是按钮所在的那条（按钮带着申请编号）；引用某条申请回复就是被引用的那条；
 *     不引用时只有一条待处理才处理它，有多条时提示引用或点按钮，不猜
 *   - 申请一直有效，直到有权限的人处理；没有权限的人点按钮、回复 Y / N 都无效（不处理，申请照旧有效）；
 *     处理过的申请再点、再回复只会提示已经处理过，不会重复执行
 *   - 群管级的申请带按钮，用 QQ 自带的「仅管理者」（群主、管理员），绝不放给所有人；
 *     主人级的申请、以及不是本群群管的主人，引用申请回复
 *   - 本人级的按钮只给发起者：用发起者在本群的原始 openid（消息事件里的 _raw_user_id），QQ 只让他本人点
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
const allowed = (e, level) => (level === 'self' ? false : level === 'manager' ? isManager(e) : !!e?.isMaster)

/** 发起者在本群的原始 openid（官方机器人的消息事件、按钮点击事件里都有） */
const rawIdOf = e => String(e?._raw_user_id ?? e?.sender?._raw_user_id ?? '')

/** 是不是本人级申请的发起者：账号一样，或官方机器人的原始 openid 一样 */
const isRequester = (e, item) => String(e?.user_id) === item.requesterId || (Boolean(item.requesterRaw) && rawIdOf(e) === item.requesterRaw)

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

/**
 * 官方机器人的确认 / 拒绝按钮（野生号发按钮会报错，不发）：
 * - 群管级用 QQ 自带的「仅管理者」权限（admin），QQ 自己判定群主、管理员
 * - 本人级只给发起者：名单里放他在本群的原始 openid（直接可用，不用换算）
 * - 主人级不发按钮：主人的 QQ 号换成群里的 openid 实测无效，谁都点不了；也不能用「仅管理者」，否则管理员也能批准。主人引用申请回复
 * QQBot-Plugin 的回调按钮 5 分钟后失效，指令同时写进 action.data，超时、重启后点击照样发出指令。
 * 点过的按钮在 QQ 里只显示自己点过，点了「确认」再点「拒绝」不能显示成已确认，所以点后都显示「已处理」，结果看回复
 */
function buttons (e, id, level, rawId) {
  if (e.bot?.adapter?.id !== 'QQBot' || typeof globalThis.segment?.button !== 'function') return []
  const permission = level === 'manager' ? 'admin' : level === 'self' && rawId ? [rawId] : null
  if (!permission) return []
  const button = (text, cmd) => ({ text, clicked_text: '已处理', callback: cmd, permission, QQBot: { action: { data: cmd } } })
  return [globalThis.segment.button([button('✅ 确认', `#确认 ${id}`), button('❌ 拒绝', `#拒绝 ${id}`)])]
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
 * @param {{ title: string, run: () => Promise<string>, level?: 'master' | 'manager' | 'self' }} action
 *   title 写清楚要做什么，run 返回执行结果；level 默认主人级，self 为只和发起者自己有关、要他本人确认
 * @returns {Promise<string>} 返回给 AI 的文字
 */
export async function guard (e, { title, run, level = 'master' }) {
  if (level === 'self') return await askSelf(e, title, run)
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
      const btn = buttons(e, id, level)
      // 官方机器人发 Markdown（群管级带按钮），野生号发普通文字
      const how = btn.length ? `${who}点按钮，或引用这条消息回复` : `${who}引用这条消息回复`
      const body = e.bot?.adapter?.id === 'QQBot'
        ? { type: 'markdown', data: `\n**${head}**\n> 申请人：${md(requester)}\n> 操作：${md(title)}\n\n${how}「#确认」/ Y 执行、「#拒绝」/ N 取消` }
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

/** 本人级：@ 发起者，请他本人确认（谁发起都一样，主人也要自己确认） */
async function askSelf (e, title, run) {
  const id = newId()
  const name = e.sender?.card || e.sender?.nickname || ''
  const requester = `${name}(${e.user_id})`
  const rawId = rawIdOf(e)
  const item = { id, title, run, level: 'self', requester, requesterId: String(e.user_id), requesterRaw: rawId, chat: chatOf(e), group_id: e.group_id, created: Date.now(), msgIds: [] }
  pending.set(id, item)
  const official = e.bot?.adapter?.id === 'QQBot'
  const btn = buttons(e, id, 'self', rawId)
  const how = `${btn.length ? '点按钮，或' : ''}引用这条消息回复「#确认」/ Y 执行、「#拒绝」/ N 取消。只有你本人能确认，其他人（包括主人）都不能代为处理`
  try {
    // 官方机器人 @ 用原始 openid（QQ 号换算出来的不一定对）
    const at = { type: 'at', qq: official && rawId ? rawId : asId(String(e.user_id)) }
    const body = official
      ? { type: 'markdown', data: `\n**【需要你本人确认】**\n> 你让我：${md(title)}\n\n${how}` }
      : ` 【需要你本人确认】你让我：${title}\n${how}`
    item.msgIds = sentIds(await e.reply(e.isGroup || e.group_id ? [at, body, ...btn] : [body, ...btn]))
  } catch (err) {
    pending.delete(id)
    return `发确认消息失败（${err.message}），操作没有执行`
  }
  return '这个操作只和发起者本人有关，已经发了确认消息，要他本人点按钮或回复确认后才会执行。告诉用户自己确认即可，不要自己再执行一次'
}

/** 能不能处理这条申请：本人级只有发起者；主人级要主人；群管级要主人，或申请所在群的群主、管理员 */
async function canDecide (e, item) {
  if (item.level === 'self') return item.chat === chatOf(e) && isRequester(e, item)
  // 群管级申请的按钮点击：QQ 已经按「仅管理者」放行；点击事件里没有群身份，
  // 没绑定 QQ 号的管理员也查不到身份，这里直接认可。手打的同样指令是普通消息，不算；主人级的申请没有按钮
  if (item.level === 'manager' && isButtonClick(e) && String(e.group_id) === String(item.group_id)) return true
  if (e?.isMaster) return true
  if (item.level !== 'manager') return false
  return String(e.group_id) === String(item.group_id) && isGroupAdmin(await grp.requesterRole(e))
}

/** QQBot-Plugin 把按钮点击转成的消息事件（sub_type 为 callback，带着原始的互动事件） */
const isButtonClick = e => e?.bot?.adapter?.id === 'QQBot' && e.sub_type === 'callback' && Boolean(e.raw?.data?.resolved)

function finish (item, text) {
  pending.delete(item.id)
  done.set(item.id, { msgIds: item.msgIds, text, level: item.level, requesterId: item.requesterId, requesterRaw: item.requesterRaw })
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
      const old = done.get(id)
      if (!(old?.level === 'self' ? isRequester(e, old) : await isManager(e))) return null
      return old ? '这条申请已经处理过了' : '这条申请已失效，请重新发起'
    }
    if (item.chat !== chat) return null
  } else if (quoted.length) {
    item = [...pending.values()].find(i => i.msgIds.some(m => quoted.includes(m)))
    if (!item) {
      const old = [...done.values()].find(d => d.msgIds.some(m => quoted.includes(m)))
      return old && (old.level === 'self' ? isRequester(e, old) : await isManager(e)) ? '这条申请已经处理过了' : null
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
  const by = item.level === 'self' ? item.requester : /^\d{5,12}$/.test(String(e.user_id)) ? `${e.sender?.card || e.sender?.nickname || ''}(${e.user_id})` : (e.sender?.card || e.sender?.nickname || '管理员')
  const whose = item.level === 'self' ? '' : ` ${item.requester} 的请求`
  if (!approve) {
    finish(item, 'rejected')
    return item.level === 'self' ? `${by} 已取消：${item.title}` : `${by} 已拒绝${whose}：${item.title}`
  }
  finish(item, 'approved')
  try {
    return `${by} 已确认${whose}：${item.title}\n${await item.run()}`
  } catch (err) {
    return `执行失败：${err.message}`
  }
}

export const list = () => [...pending.values()]
