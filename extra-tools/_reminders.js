/**
 * 提醒任务的存储与定时发送（reminder 工具共用）
 *
 * 提醒保存在 plugins/chatgpt-plugin/data/reminders.json，重启后继续有效；每 20 秒检查一次到点的提醒，
 * 用创建提醒时的机器人发到原来的群或私聊。官方机器人主动消息发不出时，由 QQBot-Plugin 交给野生号发送。
 * 插件启动时由 apps/extraTools.js 调用 start()；以 _ 开头，不会被当成工具登记。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const FILE = path.resolve('./plugins/chatgpt-plugin/data/reminders.json')
const CHECK_INTERVAL = 20 * 1000
/** 机器人离线等原因超过这么久仍没发出的提醒直接丢弃 */
const GIVE_UP_AFTER = 24 * 60 * 60 * 1000
const REPEAT = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 }

// 热重载后共用同一份状态，避免出现两个定时器重复发送
const state = (globalThis[Symbol.for('chatgpt-extra-tools-reminders')] ??= { list: null, timer: null, sending: false })

function load () {
  if (state.list) return state.list
  try {
    state.list = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : []
  } catch (err) {
    globalThis.logger?.error?.(`[提醒] 读取 ${FILE} 失败：${err.message}`)
    state.list = []
  }
  if (!Array.isArray(state.list)) state.list = []
  return state.list
}

function save () {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(state.list, null, 2))
}

export function list (filter = () => true) {
  return load().filter(filter).sort((a, b) => a.at - b.at)
}

export function add (reminder) {
  const item = { id: crypto.randomBytes(3).toString('hex'), createdAt: Date.now(), ...reminder }
  load().push(item)
  save()
  return item
}

export function remove (id) {
  const items = load()
  const index = items.findIndex(r => r.id === id)
  if (index < 0) return null
  const [removed] = items.splice(index, 1)
  save()
  return removed
}

async function send (r) {
  const bot = globalThis.Bot?.[r.self_id]
  if (!bot) throw new Error(`机器人 ${r.self_id} 不在线`)
  const msg = []
  if (r.group_id && r.mention !== false) msg.push({ type: 'at', qq: r.user_id }, ' ')
  msg.push(`⏰ 提醒：${r.text}`)
  const target = r.group_id ? bot.pickGroup(r.group_id) : bot.pickFriend(r.user_id)
  const ret = await target.sendMsg(msg)
  const ok = Array.isArray(ret?.message_id) ? ret.message_id.length > 0 : ret?.message_id != null
  if (!ok) throw new Error(ret?.error?.[0]?.message || '没有返回消息 ID')
}

export async function tick () {
  if (state.sending) return
  state.sending = true
  try {
    const now = Date.now()
    let changed = false
    for (const r of load().filter(item => item.at <= now)) {
      try {
        await send(r)
        globalThis.logger?.mark?.(`[提醒] 已发送 ${r.id}：${r.text}`)
      } catch (err) {
        if (now - r.at < GIVE_UP_AFTER) {
          globalThis.logger?.warn?.(`[提醒] ${r.id} 发送失败，稍后重试：${err.message}`)
          continue
        }
        globalThis.logger?.warn?.(`[提醒] ${r.id} 超过一天仍未发出，已放弃：${err.message}`)
      }
      if (REPEAT[r.repeat]) {
        while (r.at <= now) r.at += REPEAT[r.repeat]
      } else {
        remove(r.id)
      }
      changed = true
    }
    if (changed) save()
  } finally {
    state.sending = false
  }
}

export function start () {
  if (state.timer) return
  load()
  state.timer = setInterval(() => tick().catch(err => globalThis.logger?.error?.('[提醒] 检查失败', err)), CHECK_INTERVAL)
  state.timer.unref?.()
}

/**
 * 解析提醒时间（北京时间）：
 * “2026-10-30 08:00”、“2026-10-30T08:00”、“08:00”（今天，已过则明天）、或带时区的 ISO 时间
 */
export function parseTime (text, now = Date.now()) {
  const value = String(text ?? '').trim()
  if (!value) return NaN
  const hm = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (hm) {
    const today = new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
    let at = Date.parse(`${today}T${hm[1].padStart(2, '0')}:${hm[2]}:${hm[3] || '00'}+08:00`)
    if (at <= now) at += REPEAT.daily
    return at
  }
  const local = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (local) {
    const [, y, mo, d, h = '0', mi = '0', s = '0'] = local
    const pad = n => String(n).padStart(2, '0')
    return Date.parse(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}+08:00`)
  }
  return Date.parse(value)
}
