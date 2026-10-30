/**
 * 群信息类工具（group_info、group_members、group_activity、lucky_word、member_info）共用的辅助函数
 *
 * 群友只能查当前群，主人可以用 group_id 指定机器人加入的其他群。
 * 官方机器人拉不全群成员、查不了群资料，交给同群的野生号（QQBot-Plugin 的野生号代办，或这里直接找同群野生号）。
 * 以 _ 开头，不会被当成工具登记。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const chat = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_chat.js')).href)

export const ROLE = { owner: '群主', admin: '管理员', member: '群员' }
export const SEX = { male: '男', female: '女' }

export const isQQ = id => /^\d{5,12}$/.test(String(id ?? ''))

/** 群名片优先，没有时用昵称 */
export const nameOf = m => m.card || m.nickname || m.nick || `QQ${m.user_id}`

/** 一行成员信息：名字（QQ号）身份 */
export const line = m => `${nameOf(m)}（${m.user_id}）${m.role && m.role !== 'member' ? ` ${ROLE[m.role] || m.role}` : ''}`

/** 秒级时间戳转北京时间，0 或没有时返回空串 */
export const time = t => (Number(t) > 0 ? chat.beijing(Number(t) * 1000, { dateStyle: 'medium', timeStyle: 'short' }) : '')

/** 入群后没发过言：没有最后发言时间，或最后发言时间就是入群时间（协议端对没发过言的人这样填） */
export const neverSpoke = m => !(Number(m.last_sent_time) > 0) || Number(m.last_sent_time) === Number(m.join_time)

/** 所有机器人自己的账号 */
export const botIds = e => new Set([...(globalThis.Bot?.uin || []), e?.self_id].filter(Boolean).map(String))

/**
 * 要查询的群：不填为当前群；填了别的群只有主人可以
 * @returns {{ gid: string, current: boolean }}
 */
export function target (e, groupId) {
  const current = e?.isGroup || e?.group_id ? String(e.group_id) : ''
  const want = String(groupId ?? '').trim()
  if (want && want !== current) {
    if (!e?.isMaster) throw new Error('只有主人可以查询其他群，群友只能查询当前群')
    if (!isQQ(want)) throw new Error(`群号格式不对：${want}`)
    return { gid: want, current: false }
  }
  if (!current) throw new Error('请在群里使用（主人可以用 group_id 指定群号）')
  return { gid: current, current: true }
}

const inGroup = (bot, gid) => bot?.gl?.has?.(Number(gid)) || bot?.gl?.has?.(String(gid))

/** 能直接查这个群的野生号：当前机器人就是野生号且在群里时用它，否则找同群的野生号 */
export function wildFor (e, gid) {
  if (chat.isWildBot(e?.bot) && (inGroup(e.bot, gid) || String(e.group_id) === String(gid))) return e.bot
  return chat.wildInGroup(gid)
}

/** 必须用野生号的功能（网页接口）：找不到时说明原因 */
export function requireWild (e, gid) {
  const bot = wildFor(e, gid)
  if (bot) return bot
  if (!isQQ(gid)) throw new Error('这个群还没有群绑定（拿不到真实群号），无法交给野生号查询')
  throw new Error('这个群里没有野生号：这项数据要用 QQ 账号的网页登录凭据查询，官方机器人查不了')
}

/** 群对象：当前群直接用 e.group（官方机器人缺的方法由 QQBot-Plugin 交给野生号），其他群用野生号或当前机器人去取 */
export function groupOf (e, gid, current) {
  if (current && e.group) return e.group
  const bot = wildFor(e, gid) || e.bot
  return bot?.pickGroup?.(chat.asId(gid))
}

/** 群成员列表：优先 getMemberMap（官方机器人由野生号补全），没有时用 getMemberList */
export async function members (group) {
  if (typeof group?.getMemberMap === 'function') {
    const map = await group.getMemberMap()
    if (map instanceof Map) return [...map.entries()].map(([id, info]) => ({ ...info, user_id: info?.user_id ?? id }))
    if (map && typeof map === 'object') return Object.entries(map).map(([id, info]) => ({ ...info, user_id: info?.user_id ?? id }))
  }
  if (typeof group?.getMemberList === 'function') {
    const list = await group.getMemberList()
    return Array.isArray(list) ? list.map(i => (typeof i === 'object' ? i : { user_id: i })) : []
  }
  return []
}

/** 群成员列表，拉不到时报错：机器人自己就在群里，空列表只能是没拉到，不能当成“群里没有人” */
export async function requireMembers (group) {
  const list = await members(group)
  if (!list.length) throw new Error('没有拉到群成员列表（官方机器人需要同群有野生号）')
  return list
}

/** 只用有值的字段补上 target 里缺的字段 */
function fill (target, src) {
  if (!src || typeof src !== 'object') return
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || v === null || v === '') continue
    if (target[k] === undefined || target[k] === null || target[k] === '') target[k] = v
  }
}

/** 群资料：野生号的数据（真实群号）优先，再用当前机器人的补 */
export async function groupInfo (e, gid, current) {
  const info = {}
  const wild = wildFor(e, gid)
  const sources = [wild?.gl?.get?.(Number(gid)) || wild?.gl?.get?.(String(gid))]
  const groups = [wild?.pickGroup?.(Number(gid)), current ? e.group : null]
  for (const group of groups) {
    if (!group) continue
    try {
      sources.push(typeof group.getInfo === 'function' ? await group.getInfo() : group.info)
    } catch {}
  }
  sources.push(e.bot?.gl?.get?.(gid) || e.bot?.gl?.get?.(Number(gid)))
  for (const src of sources) fill(info, src)
  return info
}

/** 发起请求的人在群里的身份（owner / admin / member）；查不到时为空串 */
export async function requesterRole (e) {
  if (e?.sender?.role) return e.sender.role
  try {
    return (await e?.group?.pickMember?.(chat.asId(e.user_id))?.getInfo?.())?.role || ''
  } catch {
    return ''
  }
}
