import { PreProcessor, asyncLocalStorage } from 'chaite'

/**
 * 预设变量
 *
 * ikechan 版为了利用模型的提示词缓存，不替换预设（系统提示词）里的任何变量。
 * 这个前置处理器在每次请求前把预设里的 {{变量}} 换成当前消息的实际值，可用变量：
 *   {{bot_name}} {{bot_id}}       机器人昵称、账号
 *   {{user_id}} {{user_name}}     当前发消息的人的 QQ 号（官方机器人已绑定时为 QQ 号）、群名片或昵称
 *   {{group_id}} {{group_name}}   当前群号、群名；私聊时为“私聊”
 *   {{date}} {{time}} {{weekday}} 北京时间的日期、时间、星期
 * 没有列出的变量保持原样。注意：系统提示词随时间和说话人变化，模型的提示词缓存会失效。
 */

const clean = (value, max = 40) =>
  String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[{}]/g, '')
    .trim()
    .slice(0, max)

/** 群名：事件里没有时（官方机器人）从同群的其他账号那里找 */
function groupName (e) {
  const name = e.group_name || e.group?.name || e.group?.group_name
  if (name) return name
  const gid = Number(e.group_id)
  for (const id of globalThis.Bot?.uin || []) {
    const info = globalThis.Bot[id]?.gl?.get?.(gid)
    if (info?.group_name) return info.group_name
  }
  return ''
}

export function presetValues (e, now = new Date()) {
  const tz = { timeZone: 'Asia/Shanghai' }
  const bot = e?.bot || globalThis.Bot?.[e?.self_id]
  const isGroup = Boolean(e?.isGroup || e?.group_id)
  return {
    bot_name: clean(bot?.nickname || bot?.info?.username),
    bot_id: clean(e?.self_id ?? bot?.uin),
    user_id: clean(e?.user_id ?? e?.sender?.user_id),
    user_name: clean(e?.sender?.card || e?.sender?.nickname, 30),
    group_id: isGroup ? clean(e.group_id) : '私聊',
    group_name: isGroup ? clean(groupName(e)) || clean(e.group_id) : '私聊',
    date: now.toLocaleDateString('zh-CN', { ...tz, year: 'numeric', month: 'long', day: 'numeric' }),
    time: now.toLocaleTimeString('zh-CN', { ...tz, hour12: false, hour: '2-digit', minute: '2-digit' }),
    weekday: now.toLocaleDateString('zh-CN', { ...tz, weekday: 'long' })
  }
}

export function renderPreset (text, values) {
  return String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
    Object.hasOwn(values, key) && values[key] !== '' ? values[key] : match)
}

export class PresetVariablesProcessor extends PreProcessor {
  name = 'preset_variables'
  description = '把预设里的 {{user_id}}、{{date}} 等变量替换成当前消息的实际值'
  type = 'pre'

  async process (message) {
    const context = asyncLocalStorage.getStore()
    const options = context?.getOptions?.()
    const e = context?.getEvent?.()
    if (e && typeof options?.systemOverride === 'string' && options.systemOverride.includes('{{')) {
      options.systemOverride = renderPreset(options.systemOverride, presetValues(e))
    }
    return message
  }
}

export default new PresetVariablesProcessor()
