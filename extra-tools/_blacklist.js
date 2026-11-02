/**
 * 机器人黑名单：被拉黑的人发的消息，机器人在所有群和私聊里都不处理（所有插件都收不到）。
 *
 * - 拦截在 apps/extraTools.js（优先级最高的 accept，返回 'return'）
 * - 账号按 QQ 号记，官方机器人那边没绑定 QQ 号的人按原始 openid 记，两个都对得上就算
 * - 主人、机器人自己不能被拉黑；主人发的消息永远不拦
 * - 存在 plugins/chatgpt-plugin/data/blacklist.json，重启后照样有效；可以设到期时间，到期自动解除
 * 以 _ 开头，不会被当成工具登记。
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = path.resolve('./plugins/chatgpt-plugin/data/blacklist.json')
const state = (globalThis[Symbol.for('chatgpt-extra-tools-blacklist')] ??= { list: null })

function load () {
  if (state.list) return state.list
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    state.list = Array.isArray(list) ? list : []
  } catch {
    state.list = []
  }
  return state.list
}

function save () {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(state.list, null, 2))
}

/** 去掉已经到期的 */
function prune () {
  const list = load()
  const now = Date.now()
  const alive = list.filter(i => !i.until || i.until > now)
  if (alive.length !== list.length) {
    state.list = alive
    save()
  }
  return state.list
}

/** 消息事件里发消息的人的几个账号：QQ 号（或 openid）、官方机器人的原始 openid */
export const idsOf = e => [e?.user_id, e?.sender?.user_id, e?._raw_user_id, e?.sender?._raw_user_id]
  .filter(v => v !== undefined && v !== null && v !== '').map(String)

/** 找出某人的黑名单记录 */
export function find (ids) {
  const want = new Set([ids].flat().filter(Boolean).map(String))
  return prune().find(i => i.ids.some(id => want.has(id)))
}

/** 这条消息该不该拦：发消息的人在黑名单里，而且不是主人 */
export function blocked (e) {
  if (e?.isMaster) return false
  const ids = idsOf(e)
  return ids.length > 0 && Boolean(find(ids))
}

/**
 * 拉黑
 * @param {string[]} ids 账号（QQ 号 / openid）
 * @param {{ name?: string, reason?: string, by?: string, minutes?: number }} info
 */
export function add (ids, { name = '', reason = '', by = '', minutes = 0 } = {}) {
  ids = [...new Set(ids.filter(Boolean).map(String))]
  const list = prune()
  const old = list.find(i => i.ids.some(id => ids.includes(id)))
  const item = {
    ids: [...new Set([...(old?.ids || []), ...ids])],
    name: name || old?.name || '',
    reason: String(reason).slice(0, 200),
    by,
    time: Date.now(),
    until: minutes > 0 ? Date.now() + minutes * 60000 : 0
  }
  state.list = [...list.filter(i => i !== old), item]
  save()
  return item
}

/** 解除拉黑，返回被解除的记录（没有时为 undefined） */
export function remove (ids) {
  const item = find(ids)
  if (item) {
    state.list = state.list.filter(i => i !== item)
    save()
  }
  return item
}

export const list = () => prune()

/** 一条记录写成一行文字 */
export function line (item) {
  const fmt = t => new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  const id = item.ids.find(x => /^\d{5,12}$/.test(x)) || item.ids[0]
  return `${item.name ? `${item.name}（${id}）` : id}：${item.reason || '没有写原因'}；${fmt(item.time)} 由 ${item.by || '未知'} 拉黑，${item.until ? `${fmt(item.until)} 到期` : '永久'}`
}
