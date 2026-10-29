import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const TOOLS_DIR = './plugins/chatgpt-plugin/extra-tools'
const reminders = await import(pathToFileURL(path.resolve(TOOLS_DIR, '_reminders.js')).href)
const chat = await import(pathToFileURL(path.resolve(TOOLS_DIR, '_chat.js')).href)

/** 普通用户最多同时有几个提醒，主人不限 */
const MAX_PER_USER = 5
const MAX_DAYS = 365
const REPEAT_TEXT = { daily: '每天', weekly: '每周' }

const describe = r =>
  `[${r.id}] ${chat.beijing(r.at)}${REPEAT_TEXT[r.repeat] ? `（${REPEAT_TEXT[r.repeat]}）` : ''} ${r.text}${r.creator_name ? ` —— ${r.creator_name}` : ''}`

export class ReminderTool extends CustomTool {
  name = 'reminder'

  function = {
    name: 'reminder',
    description: '设置、查看、取消定时提醒。到点后机器人会在当前群（或私聊）发消息并 @ 设置提醒的人。' +
      '用户说“X点叫我”“X分钟后提醒我”“每天早上8点提醒”时用 add；时间是北京时间，不确定现在几点时先调用 get_current_time。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'list', 'cancel'],
          description: 'add=新增提醒；list=查看当前聊天里的提醒；cancel=取消提醒'
        },
        text: {
          type: 'string',
          description: 'add 时的提醒内容'
        },
        time: {
          type: 'string',
          description: 'add 时的提醒时间（北京时间），如 “2026-10-30 08:00” 或 “08:00”（今天，已过则明天）；与 delay_minutes 二选一'
        },
        delay_minutes: {
          type: 'number',
          description: 'add 时多少分钟后提醒；与 time 二选一'
        },
        repeat: {
          type: 'string',
          enum: ['none', 'daily', 'weekly'],
          description: '重复：none=只提醒一次（默认），daily=每天，weekly=每周'
        },
        id: {
          type: 'string',
          description: 'cancel 时要取消的提醒编号（list 里方括号中的编号）'
        }
      },
      required: ['action']
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '当前没有可用的聊天'
    reminders.start()
    const groupId = e.isGroup || e.group_id ? e.group_id : null
    const userId = String(e.user_id)
    const inChat = r => String(r.self_id) === String(e.self_id) &&
      (groupId ? String(r.group_id) === String(groupId) : !r.group_id && String(r.user_id) === userId)

    if (args.action === 'list') {
      const items = reminders.list(r => inChat(r) && (e.isMaster || String(r.user_id) === userId))
      if (!items.length) return '当前聊天里没有你设置的提醒'
      return `当前的提醒（北京时间）：\n${items.map(describe).join('\n')}`
    }

    if (args.action === 'cancel') {
      const id = String(args.id || '').trim()
      const item = reminders.list(r => r.id === id && inChat(r))[0]
      if (!item) return `没有找到编号为 ${id} 的提醒，先用 list 查看编号`
      if (!e.isMaster && String(item.user_id) !== userId) return '只能取消自己设置的提醒'
      reminders.remove(id)
      return `已取消提醒：${describe(item)}`
    }

    if (args.action !== 'add') return 'action 只能是 add、list 或 cancel'
    const text = String(args.text || '').replace(/\s+/g, ' ').trim()
    if (!text) return '请提供提醒内容'
    if (text.length > 200) return '提醒内容不能超过 200 字'
    const now = Date.now()
    const at = args.delay_minutes != null && args.delay_minutes !== ''
      ? now + Number(args.delay_minutes) * 60 * 1000
      : reminders.parseTime(args.time, now)
    if (!Number.isFinite(at)) return '时间格式不对，请用 “2026-10-30 08:00”、“08:00” 或 delay_minutes'
    if (at < now - 60 * 1000) return `这个时间（${chat.beijing(at)}）已经过去了`
    if (at > now + MAX_DAYS * 24 * 60 * 60 * 1000) return `最多只能设置 ${MAX_DAYS} 天以内的提醒`
    if (!e.isMaster && reminders.list(r => String(r.user_id) === userId).length >= MAX_PER_USER) {
      return `每人最多同时设置 ${MAX_PER_USER} 个提醒，先取消一些再加`
    }
    const item = reminders.add({
      self_id: e.self_id,
      group_id: groupId,
      user_id: e.user_id,
      creator_name: e.sender?.card || e.sender?.nickname || '',
      text,
      at: Math.max(at, now + 5000),
      repeat: args.repeat === 'daily' || args.repeat === 'weekly' ? args.repeat : 'none'
    })
    return `已设置提醒：${describe(item)}`
  }
}

export default new ReminderTool()
