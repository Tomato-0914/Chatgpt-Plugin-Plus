import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Chaite, CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)
const quote = await import(pathToFileURL(path.resolve(dir, '_quote.js')).href)

let Config
const config = async () => (Config ??= (await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/config/config.js')).href)).default)

const MAX_CHAIN = 5
const isOfficial = e => e?.bot?.adapter?.id === 'QQBot'
const time = t => (Number(t) > 0 ? chat.beijing(Number(t) * 1000) : '')

/* ---------- 结束对话 ---------- */

/**
 * 结束对话：把用户状态里的当前对话换成新的。
 * 工具是在本轮对话中途执行的，本轮结束时 apps/chat.js 会把旧的对话编号再存回去，
 * 所以先记下“要结束”，在本轮保存用户状态时再换一次（5 分钟内有效）
 */
const pendingClear = (globalThis[Symbol.for('chatgpt-extra-tools-clear')] ??= new Map())
const CLEAR_TTL = 5 * 60 * 1000
const WRAPPED = Symbol.for('chatgpt-extra-tools-clear-wrapped')

function fresh (state) {
  state.current = { ...state.current, conversationId: crypto.randomUUID(), messageId: crypto.randomUUID() }
  return state
}

function wrapStorage (storage) {
  if (storage[WRAPPED]) return
  const setItem = storage.setItem.bind(storage)
  storage.setItem = async (key, value, ...rest) => {
    const until = pendingClear.get(String(key))
    if (until) {
      pendingClear.delete(String(key))
      if (until > Date.now() && value?.current) fresh(value)
    }
    return setItem(key, value, ...rest)
  }
  storage[WRAPPED] = true
}

async function clearConversation (e, userId) {
  const storage = Chaite.getInstance?.()?.getUserStateStorage?.()
  if (!storage) return '对话服务还没有初始化'
  const state = await storage.getItem(String(userId))
  if (!state?.current?.conversationId) return `${userId === String(e.user_id) ? '你' : userId}当前没有进行中的对话`
  wrapStorage(storage)
  await storage.setItem(String(userId), fresh(state))
  pendingClear.set(String(userId), Date.now() + CLEAR_TTL)
  return `已结束${userId === String(e.user_id) ? '' : ` ${userId} 的`}当前对话，这条回复之后开始新对话（之前的对话内容不再带入；群聊上下文是群里的聊天记录，不受影响）`
}

/* ---------- @ 列表 ---------- */

async function atList (e) {
  const ats = (Array.isArray(e.message) ? e.message : []).filter(s => s?.type === 'at')
  if (!ats.length) return []
  const bots = grp.botIds(e)
  return Promise.all(ats.map(async seg => {
    const qq = String(seg.qq ?? seg.data?.qq ?? '')
    if (qq === 'all') return { qq, line: '@全体成员' }
    let info = {}
    try {
      info = await e.group?.pickMember?.(chat.asId(qq))?.getInfo?.() || {}
    } catch {}
    const name = info.card || info.nickname || String(seg.text ?? seg.data?.text ?? '').replace(/^@/, '')
    const role = info.role && info.role !== 'member' ? ` ${grp.ROLE[info.role] || info.role}` : ''
    const tags = [bots.has(qq) && '机器人自己', !grp.isQQ(qq) && '还没绑定 QQ 号'].filter(Boolean)
    return { qq, line: `${name || '未知'}（${qq}）${role}${tags.length ? `（${tags.join('，')}）` : ''}` }
  }))
}

/* ---------- 当前会话 / 对话详情 ---------- */

async function current (e) {
  const lines = []
  if (e.isGroup || e.group_id) {
    const name = e.group?.name || e.group?.group_name || e.bot?.gl?.get?.(Number(e.group_id))?.group_name || e.bot?.gl?.get?.(String(e.group_id))?.group_name || ''
    lines.push(`场景：群聊${name ? `「${name}」` : ''}（${e.group_id}）`)
  } else {
    lines.push('场景：私聊')
  }
  const role = e.isGroup || e.group_id ? await grp.requesterRole(e) : ''
  const name = e.sender?.card || e.sender?.nickname || ''
  lines.push(`说话的人：${name}（${e.user_id}）${role ? ` ${grp.ROLE[role] || role}` : ''}${e.isMaster ? '，是主人' : ''}`)
  const botName = e.bot?.nickname || e.bot?.info?.nickname || ''
  lines.push(`机器人：${botName}（${e.self_id}），${isOfficial(e) ? 'QQ 官方机器人' : chat.isWildBot(e.bot) ? `QQ 号机器人（${e.bot.adapter.name}）` : e.bot?.adapter?.name || '未知适配器'}`)
  if (isOfficial(e) && e.group_id) {
    const wild = chat.wildInGroup(e.group_id)
    lines.push(`同群野生号：${wild ? `有（${wild.uin}），读群消息记录、合并转发等由它代办` : '没有，读不到群消息记录'}`)
  }
  if (e.time) lines.push(`消息时间：${time(e.time)}`)
  lines.push(`引用：${e.source || e.reply_id ? '有（用 action=reply 读取被引用的内容）' : '没有'}`)
  const ats = await atList(e)
  lines.push(`@ 了：${ats.length ? ats.map(a => a.line).join('、') : '没有'}`)
  return lines.join('\n')
}

async function conversation (e) {
  const cfg = await config()
  const instance = Chaite.getInstance?.()
  if (!instance) return '对话服务还没有初始化'
  const state = await instance.getUserStateStorage().getItem(String(e.sender?.user_id ?? e.user_id)).catch(() => null)
  const presetId = state?.settings?.preset || cfg.llm?.defaultChatPresetId
  const preset = presetId ? await instance.getChatPresetManager().getInstance(presetId).catch(() => null) : null
  const lines = [`预设：${preset ? `${preset.name || ''}（${preset.id || presetId}）` : presetId || '未设置'}`]
  const model = state?.settings?.model || preset?.sendMessageOption?.model
  if (model) lines.push(`模型：${model}`)

  if (state?.current?.conversationId) {
    let rounds = 0
    try {
      const history = await instance.getHistoryManager().getHistory(state.current.messageId, state.current.conversationId)
      rounds = history.filter(m => m.role === 'user' && !m._chatgptDynamicContext).length
    } catch {}
    lines.push(`当前对话：${state.current.conversationId.slice(0, 8)}，之前已经聊了 ${rounds} 轮${preset?.disableConversationContext ? '（这个预设不带入之前的对话）' : ''}`)
  } else {
    lines.push('当前对话：这是新对话')
  }
  const toggle = cfg.basic?.toggleMode === 'prefix' ? `前缀「${cfg.basic.togglePrefix}」` : '@ 机器人'
  lines.push(`触发方式：${toggle}`)
  if (e.isGroup || e.group_id) {
    const groupContext = !preset?.groupContext || preset.groupContext === 'use_system' ? cfg.llm?.enableGroupContext : preset.groupContext === 'enabled'
    lines.push(`群聊上下文：${groupContext ? `开启，每次带入最近 ${cfg.llm?.groupContextLength ?? 20} 条群消息` : '关闭'}`)
    const groupMemory = cfg.memory?.group?.enable && (!cfg.memory.group.enabledGroups?.length || cfg.memory.group.enabledGroups.map(String).includes(String(e.group_id)))
    lines.push(`群记忆：${groupMemory ? '开启' : '关闭'}`)
  }
  if (cfg.memory?.user) lines.push(`用户记忆：${cfg.memory.user.enable ? '开启' : '关闭'}`)
  lines.push('结束当前对话：action=clear，或发送 #结束对话')
  return lines.join('\n')
}

export class ChatContextTool extends CustomTool {
  name = 'chat_context'

  function = {
    name: 'chat_context',
    description: '当前聊天的上下文：' +
      '当前会话（current：群聊还是私聊、群名、说话人的群身份和是不是主人、机器人是官方还是 QQ 号、有没有引用、@ 了谁）；' +
      '读取被引用的消息（reply：用户引用 / 回复了一条消息而你看不到它的文字时用，会带上发送人、时间，以及它引用的消息）；' +
      '@ 列表（at：这条消息 @ 了哪些人，带 QQ 号、群名片和身份，踢人、禁言等需要 QQ 号时用）；' +
      '对话详情（conversation：用的预设和模型、这次对话聊了几轮、群聊上下文和记忆是否开启）；' +
      '结束对话（clear：用户要求“忘掉之前的对话 / 重新开始 / 结束对话”时用，等同 #结束对话）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['current', 'reply', 'at', 'conversation', 'clear'],
          description: 'current=当前会话（默认），reply=被引用的消息，at=@ 列表，conversation=对话详情，clear=结束当前对话'
        },
        depth: {
          type: 'number',
          description: 'reply 时往上追几层引用（被引用的消息又引用了别的），默认 2，最多 5'
        },
        user_id: {
          type: 'string',
          description: 'clear 时结束谁的对话，默认说话的人；只有主人可以结束别人的对话'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '拿不到当前消息'
    try {
      switch (args.action || 'current') {
        case 'current':
          return await current(e)
        case 'reply':
          return await quote.replyText(e, Math.min(Math.max(Math.floor(Number(args.depth ?? 2)) || 0, 0), MAX_CHAIN))
        case 'at': {
          const list = await atList(e)
          return list.length ? `这条消息 @ 了 ${list.length} 个：\n${list.map((a, i) => `${i + 1}. ${a.line}`).join('\n')}` : '这条消息没有 @ 任何人'
        }
        case 'conversation':
          return await conversation(e)
        case 'clear': {
          const self = String(e.sender?.user_id ?? e.user_id)
          const uid = String(args.user_id ?? '').replace(/^@/, '').trim() || self
          if (uid !== self && !e.isMaster) return '只有主人可以结束别人的对话'
          return await clearConversation(e, uid)
        }
        default:
          return 'action 不正确'
      }
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new ChatContextTool()
