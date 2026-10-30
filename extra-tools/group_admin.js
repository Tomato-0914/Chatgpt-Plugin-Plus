import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const approval = await import(pathToFileURL(path.resolve(dir, '_approval.js')).href)

const MAX_MUTE_MINUTES = 30 * 24 * 60
const MAX_RECALL = 10
/** 撤回时往前翻多少条群消息来定位要撤的消息 */
const RECALL_SCAN = 200
const NEEDS_USER = new Set(['mute', 'unmute', 'kick', 'set_card', 'set_title'])

/** 常见错误码换成能看懂的说明 */
const ERRORS = [
  [/NOT_GROUP_ADMIN|not.*admin|权限不足|无权限|permission/i, '机器人不是群管理员'],
  [/40062003/, '官方机器人只能撤回自己发的消息'],
  [/OWNER|群主/i, '对方是群主或管理员，机器人没有权限']
]
const explain = text => {
  const hit = ERRORS.find(([re]) => re.test(text))
  return hit ? `${hit[1]}（${text}）` : text
}

/** 执行群管理的机器人：官方机器人一般不是管理员，也拉不到群消息记录，优先用同群的野生号 */
function adminBot (e) {
  if (chat.isWildBot(e.bot)) return e.bot
  return chat.wildInGroup(e.group_id) || e.bot
}

/**
 * 接口返回结果里的错误；没有错误时返回空串
 * OneBot 失败时返回 { status: 'failed' }，撤回接口把每条的结果（含 Error）放进数组；
 * 官方机器人撤不了别人的消息时返回 false
 */
function failure (ret) {
  for (const item of Array.isArray(ret) ? ret : [ret]) {
    if (item === false) return '官方机器人只能撤回自己发的消息（或消息 ID 无效）'
    if (item instanceof Error) return explain(item.message)
    if (item?.status === 'failed' || (item?.retcode && item.retcode !== 0)) {
      return explain(item.wording || item.message || item.msg || `错误码 ${item.retcode}`)
    }
  }
  return ''
}

async function call (fn) {
  let ret
  try {
    ret = await fn()
  } catch (err) {
    throw new Error(explain(err.message))
  }
  const error = failure(ret)
  if (error) throw new Error(error)
  return ret
}

const preview = text => (text.length > 30 ? `${text.slice(0, 30)}…` : text) || '（无文字）'

/** 官方机器人的群对象（撤回官方机器人自己发的消息用，走官方的撤回接口） */
const officialGroup = e => (chat.isWildBot(e.bot) ? null : e.bot?.pickGroup?.(e.group_id))

/**
 * 官方机器人自己最近发的消息：官方接口只能撤回机器人自己的消息，但拉不到历史消息，
 * 消息 ID 从 QQBot-Plugin 的本地消息记录里取（group.getRecentMsgs）
 */
async function officialOwn (e, count, keyword) {
  const group = officialGroup(e)
  if (typeof group?.getRecentMsgs !== 'function') throw new Error('QQBot-Plugin 版本太旧，不支持撤回官方机器人自己的消息，请更新 QQBot-Plugin')
  const before = Number(e.time) || Infinity
  // 多取一些：本轮对话里机器人刚发的（如思考过程）发在请求之后，要排除
  const records = (await group.getRecentMsgs(count + 20, 'outgoing'))
    .filter(r => Number(r.time) < before)
    .filter(r => !keyword || String(r.raw_message || '').toLowerCase().includes(keyword))
    .slice(-count)
  if (!records.length) throw new Error('没有找到官方机器人最近发的、符合条件的消息')
  const name = e.bot?.nickname || '机器人'
  return { group, targets: records.map(r => ({ id: r.message_id, desc: `${name}：${preview(String(r.raw_message || ''))}` })) }
}

/**
 * 找出要撤回的消息，返回 { group, targets: [{ id, desc }] }，group 为执行撤回的群对象
 * 优先级：message_id → 引用的消息（“撤回这条”）→ 按 user_id / keyword 取最近的几条
 * 官方机器人自己发的消息走官方接口，其余的由同群野生号撤回
 */
async function locateRecall (e, bot, gid, args) {
  const group = bot.pickGroup(gid)
  const id = String(args.message_id ?? '').trim()
  if (id) {
    if (!/^-?\d+$/.test(id)) {
      // 官方机器人的消息 ID：只能由官方机器人撤回它自己发的消息
      const og = officialGroup(e)
      if (og) return { group: og, targets: [{ id, desc: `消息 ${id}` }] }
      throw new Error('这是官方机器人的消息 ID，野生号用不了；请改为引用那条消息，或用 user_id / keyword 定位')
    }
    return { group, targets: [{ id, desc: `消息 ${id}` }] }
  }

  const userId = String(args.user_id ?? '').replace(/^@/, '').trim()
  const keyword = String(args.keyword ?? '').trim().toLowerCase()
  const count = Math.min(Math.max(Math.floor(Number(args.count) || 1), 1), MAX_RECALL)

  // 引用了官方机器人自己发的消息，或要撤回官方机器人自己的消息：走官方接口
  if (!chat.isWildBot(e.bot)) {
    if (e.source && !userId && !keyword) {
      const reply = await e.getReply?.().catch(() => null)
      if (reply?.message_id && (reply.direction === 'outgoing' || reply.sender?.bot)) {
        return { group: officialGroup(e), targets: [{ id: reply.message_id, desc: `${e.bot?.nickname || '机器人'}：${preview(String(reply.raw_message || ''))}` }] }
      }
    }
    if (userId === 'bot' || userId === String(e.self_id)) return officialOwn(e, count, keyword)
  }
  if (!chat.isWildBot(bot)) throw new Error('这个群里没有野生号：官方机器人拉不到群消息记录，只能撤回它自己发的消息（user_id 写 bot）')

  const describe = m => ({
    id: m.message_id,
    desc: `${m.sender?.card || m.sender?.nickname || ''}(${m.user_id ?? m.sender?.user_id})：${preview(chat.textOf(m))}`
  })

  // 引用了一条消息并且没有给其他条件：撤回被引用的那条（官方机器人收到的引用到野生号的消息记录里找同一条）
  if (e.source && !userId && !keyword) {
    try {
      return { group, targets: [describe(await chat.quotedMessage(e, bot, gid, { scan: RECALL_SCAN }))] }
    } catch (err) {
      throw new Error(`${err.message}；请用 user_id / keyword 定位`)
    }
  }

  if (!userId && !keyword) throw new Error('请引用要撤回的消息，或提供 user_id（谁发的）/ keyword（内容关键词）')
  // user_id 写 bot 时撤回野生号自己发的消息（官方机器人的在前面已经处理）
  const users = userId === 'bot' ? [String(bot.uin)] : userId ? [userId] : null
  // 不撤回发起这次请求的那条消息，以及之后机器人发的提示
  const list = await chat.recentMessages(e, bot, gid, { users, keyword, count, scan: RECALL_SCAN })
  if (!list.length) throw new Error(`最近 ${RECALL_SCAN} 条群消息里没有找到符合条件的消息`)
  return { group, targets: list.map(describe) }
}

export class GroupAdminTool extends CustomTool {
  name = 'group_admin'

  function = {
    name: 'group_admin',
    description: '群管理：禁言、解除禁言、踢人、改群名片、设专属头衔、全员禁言、撤回消息。' +
      '主人要求时直接执行；其他人要求时会自动 @ 主人申请确认，主人确认后才执行（告诉用户等主人确认即可）。' +
      '需要机器人（同群的野生号）是管理员，头衔需要群主。不要对机器人自己操作。' +
      '撤回：用户引用一条消息说“撤回这条 / 把这条撤回”时直接 action=recall，工具会自己读取引用的消息（包括机器人自己发的），即使你在上下文里看不到引用内容也不要拒绝或追问；要撤回某人最近的消息用 user_id + count，按内容撤回用 keyword；' +
      '撤回机器人自己发的消息时 user_id 写 bot（官方机器人自己的消息走官方接口撤回）。不要编造 message_id。',
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
          description: '操作对象的 QQ 号（mute / unmute / kick / set_card / set_title 必填）；recall 时表示撤回谁发的消息，写 bot 表示机器人自己'
        },
        minutes: {
          type: 'number',
          description: 'mute 的禁言时长（分钟），默认 10，最多 43200（30 天）'
        },
        text: {
          type: 'string',
          description: 'set_card 的新名片，或 set_title 的头衔（为空表示清除）'
        },
        keyword: {
          type: 'string',
          description: 'recall 时按消息内容里的关键词定位'
        },
        count: {
          type: 'number',
          description: 'recall 时撤回最近几条（按 user_id / keyword 筛选后），默认 1，最多 10'
        },
        message_id: {
          type: 'string',
          description: 'recall 时直接指定消息 ID（只在确实知道 ID 时填写）'
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
        let targets, recallGroup
        try {
          ({ targets, group: recallGroup } = await locateRecall(e, bot, gid, args))
        } catch (err) {
          return `撤回失败：${err.message}`
        }
        if (typeof recallGroup?.recallMsg !== 'function') return '当前机器人不支持撤回消息'

        // 申请确认时把要撤的消息列出来，主人看清楚再确认
        title = targets.length === 1
          ? `撤回消息 ${targets[0].desc}`
          : `撤回 ${targets.length} 条消息：\n${targets.map((t, i) => `${i + 1}. ${t.desc}`).join('\n')}`
        run = async () => {
          const failed = []
          for (const t of targets) {
            try {
              await call(() => recallGroup.recallMsg(t.id))
            } catch (err) {
              failed.push(err.message)
            }
          }
          if (failed.length === targets.length) throw new Error(failed[0])
          if (failed.length) return `撤回了 ${targets.length - failed.length} 条，${failed.length} 条失败：${failed[0]}`
        }
        break
      }
      default:
        return 'action 不正确'
    }
    for (const method of [['mute', 'muteMember'], ['unmute', 'muteMember'], ['kick', 'kickMember'], ['set_card', 'setCard'],
      ['set_title', 'setTitle'], ['mute_all', 'muteAll'], ['unmute_all', 'muteAll']]) {
      if (method[0] === action && typeof group[method[1]] !== 'function') return '当前机器人不支持这个群管理操作'
    }

    // 结果里只带标题第一行（多条撤回时后面是消息列表）
    const head = title.split('\n')[0].replace(/：$/, '')
    try {
      return await approval.guard(e, {
        title,
        run: async () => {
          // 撤回部分失败时 run 返回说明文字；其他操作返回的是接口原始结果，不当作回复
          const result = await run()
          return typeof result === 'string' ? result : `${head}（已完成）`
        }
      })
    } catch (err) {
      return `${head}（失败：${err.message}）`
    }
  }
}

export default new GroupAdminTool()
