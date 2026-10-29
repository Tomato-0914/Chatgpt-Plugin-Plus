import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const approval = await import(pathToFileURL(path.resolve(dir, '_approval.js')).href)

const MAX_MUTE_MINUTES = 30 * 24 * 60
const NEEDS_USER = new Set(['mute', 'unmute', 'kick', 'set_card', 'set_title'])

/** 执行群管理的机器人：官方机器人一般不是管理员，优先用同群的野生号 */
function adminBot (e) {
  if (chat.isWildBot(e.bot)) return e.bot
  return chat.wildInGroup(e.group_id) || e.bot
}

/** OneBot 返回 { status: 'failed' } 或抛错都算失败 */
async function call (fn) {
  const ret = await fn()
  if (ret?.status === 'failed' || (ret?.retcode && ret.retcode !== 0)) {
    throw new Error(ret.wording || ret.message || ret.msg || `错误码 ${ret.retcode}`)
  }
  return ret
}

export class GroupAdminTool extends CustomTool {
  name = 'group_admin'

  function = {
    name: 'group_admin',
    description: '群管理：禁言、解除禁言、踢人、改群名片、设专属头衔、全员禁言、撤回消息。' +
      '主人要求时直接执行；其他人要求时会自动 @ 主人申请确认，主人确认后才执行（告诉用户等主人确认即可）。' +
      '需要机器人（同群的野生号）是管理员，头衔需要群主。不要对机器人自己操作。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['mute', 'unmute', 'kick', 'set_card', 'set_title', 'mute_all', 'unmute_all', 'recall'],
          description: 'mute=禁言，unmute=解除禁言，kick=踢出群，set_card=改群名片，set_title=设专属头衔，mute_all/unmute_all=开关全员禁言，recall=撤回消息'
        },
        user_id: {
          type: 'string',
          description: '操作对象的 QQ 号（mute / unmute / kick / set_card / set_title 必填）'
        },
        minutes: {
          type: 'number',
          description: 'mute 的禁言时长（分钟），默认 10，最多 43200（30 天）'
        },
        text: {
          type: 'string',
          description: 'set_card 的新名片，或 set_title 的头衔（为空表示清除）'
        },
        message_id: {
          type: 'string',
          description: 'recall 要撤回的消息 ID'
        },
        reject_add: {
          type: 'boolean',
          description: 'kick 时是否拒绝此人再次加群，默认 false'
        }
      },
      required: ['action']
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e?.isGroup && !e?.group_id) return '群管理只能在群里用'
    const gid = Number(e.group_id)
    if (!gid) return '这个群还没有群绑定（不知道真实群号），无法执行群管理'
    const bot = adminBot(e)
    const group = bot?.pickGroup?.(gid)
    if (!group) return '没有可以执行群管理的机器人'

    const action = args.action
    const uid = String(args.user_id ?? '').replace(/^@/, '').trim()
    if (NEEDS_USER.has(action)) {
      if (!uid) return '请提供操作对象的 QQ 号'
      if ([String(bot.uin), String(e.self_id)].includes(uid)) return '不能对机器人自己执行这个操作'
      if (['mute', 'kick'].includes(action) && !e.isMaster && await approval.isMaster(e, uid)) return '不能对主人执行这个操作'
    }
    const target = chat.asId(uid)
    const text = String(args.text ?? '').trim()

    let title, run
    switch (action) {
      case 'mute': {
        const minutes = Math.min(Math.max(Math.floor(Number(args.minutes) || 10), 1), MAX_MUTE_MINUTES)
        title = `禁言 ${uid} ${minutes} 分钟`
        run = () => call(() => group.muteMember(target, minutes * 60))
        break
      }
      case 'unmute':
        title = `解除 ${uid} 的禁言`
        run = () => call(() => group.muteMember(target, 0))
        break
      case 'kick':
        title = `把 ${uid} 踢出群${args.reject_add ? '（并拒绝再次加群）' : ''}`
        run = () => call(() => group.kickMember(target, Boolean(args.reject_add)))
        break
      case 'set_card':
        title = text ? `把 ${uid} 的群名片改成「${text.slice(0, 60)}」` : `清除 ${uid} 的群名片`
        run = () => call(() => group.setCard(target, text.slice(0, 60)))
        break
      case 'set_title':
        title = text ? `给 ${uid} 设置头衔「${text.slice(0, 18)}」` : `清除 ${uid} 的头衔`
        run = () => call(() => group.setTitle(target, text.slice(0, 18)))
        break
      case 'mute_all':
      case 'unmute_all':
        title = action === 'mute_all' ? '开启全员禁言' : '关闭全员禁言'
        run = () => call(() => group.muteAll(action === 'mute_all'))
        break
      case 'recall': {
        const id = String(args.message_id ?? '').trim()
        if (!id) return '请提供要撤回的消息 ID'
        title = `撤回消息 ${id}`
        run = () => call(() => group.recallMsg(id))
        break
      }
      default:
        return 'action 不正确'
    }
    for (const method of [['mute', 'muteMember'], ['unmute', 'muteMember'], ['kick', 'kickMember'], ['set_card', 'setCard'],
      ['set_title', 'setTitle'], ['mute_all', 'muteAll'], ['unmute_all', 'muteAll'], ['recall', 'recallMsg']]) {
      if (method[0] === action && typeof group[method[1]] !== 'function') return '当前机器人不支持这个群管理操作'
    }

    try {
      return await approval.guard(e, {
        title,
        run: async () => {
          await run()
          return `${title}：完成`
        }
      })
    } catch (err) {
      return `${title}失败：${err.message}（机器人可能不是管理员，或对方是管理员 / 群主）`
    }
  }
}

export default new GroupAdminTool()
