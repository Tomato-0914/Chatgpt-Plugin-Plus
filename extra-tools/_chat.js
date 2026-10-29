/**
 * 与聊天、群操作相关的工具共用的辅助函数
 *
 * 官方机器人没有的群操作（戳一戳、点赞、查群员、拉群消息记录等）由 QQBot-Plugin 的野生号辅助代办，
 * 这里照常调用 Yunzai 的群 / 成员 / 好友对象即可。以 _ 开头，不会被当成工具登记。
 */

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
