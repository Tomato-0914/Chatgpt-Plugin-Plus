import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)
const approval = await import(pathToFileURL(path.resolve(dir, '_approval.js')).href)

const MAX_MUTE_MINUTES = 30 * 24 * 60
const MAX_RECALL = 10
/** 撤回时往前翻多少条群消息来定位要撤的消息 */
const RECALL_SCAN = 200
const NEEDS_USER = new Set(['mute', 'unmute', 'kick', 'set_card', 'set_title', 'blacklist_add', 'blacklist_remove'])
/** 对人“动手”的操作：不能对主人做（主人自己除外），管理员不能对群主、其他管理员做 */
const HOSTILE = new Set(['mute', 'kick', 'set_card', 'set_title', 'blacklist_add'])
const isGroupAdmin = role => role === 'owner' || role === 'admin'

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

/** 撤回用的机器人：官方机器人拉不到群消息记录，优先用同群的野生号 */
function adminBot (e) {
  if (chat.isWildBot(e.bot)) return e.bot
  return chat.wildInGroup(e.group_id) || e.bot
}

/**
 * 接口返回结果里的错误；没有错误时返回空串
 * OneBot 失败时返回 { status: 'failed' }，撤回接口把每条的结果（含 Error）放进数组；
 * 官方机器人撤不了别人的消息时返回 false
 */
function failure (ret, falseText = '官方机器人只能撤回自己发的消息（或消息 ID 无效）') {
  for (const item of Array.isArray(ret) ? ret : [ret]) {
    if (item === false) return falseText
    if (item instanceof Error) return explain(item.message)
    if (item?.status === 'failed' || (item?.retcode && item.retcode !== 0)) {
      return explain(item.wording || item.message || item.msg || `错误码 ${item.retcode}`)
    }
  }
  return ''
}

async function call (fn, falseText) {
  let ret
  try {
    ret = await fn()
  } catch (err) {
    throw new Error(explain(err.message))
  }
  const error = failure(ret, falseText)
  if (error) throw new Error(error)
  return ret
}

const preview = text => (text.length > 30 ? `${text.slice(0, 30)}…` : text) || '（无文字）'

/** 官方机器人的群对象（撤回官方机器人自己发的消息用，走官方的撤回接口） */
const officialGroup = e => (chat.isWildBot(e.bot) ? null : e.bot?.pickGroup?.(e.group_id))

/**
 * 能执行禁言、踢人、拉黑的官方机器人群对象：当前是官方机器人，且不确定它不是管理员
 * （群信息里的 member_role 缓存 10 分钟，拿不到时照样试，接口会报错）
 */
async function officialAdmin (e) {
  if (e.bot?.adapter?.id !== 'QQBot') return null
  const og = officialGroup(e)
  if (!og) return null
  const role = og.member_role || (await og.getInfo?.().catch(() => null))?.member_role
  return role && !isGroupAdmin(role) ? null : og
}

/**
 * 依次用官方机器人、同群野生号执行，前一个失败再换下一个；都失败时把每个的原因说出来
 * @param {Array<[string, () => Promise<*>] | null>} tries [谁, 执行]，null 表示这个机器人不可用
 */
async function tryEach (tries) {
  tries = tries.filter(Boolean)
  if (!tries.length) throw new Error('没有能执行的机器人：官方机器人不是群管理员，这个群里也没有野生号')
  const errors = []
  for (const [who, fn] of tries) {
    try {
      return await call(fn, '接口返回失败')
    } catch (err) {
      errors.push(tries.length > 1 ? `${who}：${err.message}` : err.message)
    }
  }
  throw new Error(errors.join('；'))
}

/** 群成员的身份（owner / admin / member），拿不到时返回空串 */
async function roleOf (groups, uid) {
  for (const g of groups) {
    try {
      const role = (await g?.pickMember?.(chat.asId(uid))?.getInfo?.())?.role
      if (role) return role
    } catch {}
  }
  return ''
}

/** 野生号踢人：ICQQ 是 (QQ, 提示语, 拉黑)，OneBot 是 (QQ, 拉黑) */
const wildKick = (bot, group, uid, block) => (bot.adapter?.name === 'ICQQ' ? group.kickMember(uid, '', block) : group.kickMember(uid, block))

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
    description: '群管理：禁言、解除禁言、踢人、群黑名单（查看、拉黑、移出）、改群名片、设专属头衔、全员禁言、撤回消息。' +
      '主人、本群群主、管理员要求时直接执行；其他人要求时会自动 @ 主人申请确认，主人或本群群主、管理员确认后才执行（告诉用户等确认即可）。' +
      '不能对主人、机器人自己操作；管理员不能对群主、其他管理员操作。' +
      '禁言、踢人、拉黑优先用官方机器人（需要是管理员），不行再交给同群的野生号；名片、头衔、全员禁言、撤回别人的消息要同群野生号是管理员，头衔需要群主。' +
      '撤回：用户引用一条消息说“撤回这条 / 把这条撤回”时直接 action=recall，工具会自己读取引用的消息（包括机器人自己发的），即使你在上下文里看不到引用内容也不要拒绝或追问；要撤回某人最近的消息用 user_id + count，按内容撤回用 keyword；' +
      '撤回机器人自己发的消息时 user_id 写 bot（官方机器人自己的消息走官方接口撤回）。不要编造 message_id。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['mute', 'unmute', 'kick', 'blacklist', 'blacklist_add', 'blacklist_remove', 'set_card', 'set_title', 'mute_all', 'unmute_all', 'recall'],
          description: 'mute=禁言，unmute=解除禁言，kick=踢出群，blacklist=查看群黑名单，blacklist_add=加入群黑名单（不能再加群），blacklist_remove=移出群黑名单，' +
            'set_card=改群名片，set_title=设专属头衔，mute_all/unmute_all=开关全员禁言，recall=撤回消息'
        },
        user_id: {
          type: 'string',
          description: '操作对象的 QQ 号（mute / unmute / kick / blacklist_add / blacklist_remove / set_card / set_title 必填）；recall 时表示撤回谁发的消息，写 bot 表示机器人自己'
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
          description: 'kick 时是否同时拉黑（拒绝此人再次加群），默认 false'
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
    const wild = chat.isWildBot(e.bot) ? e.bot : chat.wildInGroup(gid)
    const wg = wild?.pickGroup?.(gid) || null
    const og = await officialAdmin(e)

    const action = args.action
    const uid = String(args.user_id ?? '').replace(/^@/, '').trim()
    if (NEEDS_USER.has(action)) {
      if (!uid) return '请提供操作对象的 QQ 号'
      if (grp.botIds(e).has(uid) || (wild && String(wild.uin) === uid)) return '不能对机器人自己执行这个操作'
      // 主人不受限制；对自己操作（如改自己的名片）不受限制
      if (HOSTILE.has(action) && !e.isMaster && uid !== String(e.user_id)) {
        if (await approval.isMaster(e, uid)) return '不能对主人执行这个操作'
        const theirs = await roleOf([wg, officialGroup(e)], uid)
        if (theirs === 'owner') return '不能对群主执行这个操作'
        if (theirs === 'admin' && await grp.requesterRole(e) !== 'owner') return '对方是管理员，只有主人和群主可以对管理员执行这个操作'
      }
    }
    const target = chat.asId(uid)
    const text = String(args.text ?? '').trim()

    // 名片、头衔、全员禁言官方机器人没有接口，只能交给同群野生号
    const needWild = () => (wg ? null : '这个群里没有野生号，官方机器人没有改名片、设头衔、全员禁言的接口')

    let title, run
    switch (action) {
      case 'mute': {
        const minutes = Math.min(Math.max(Math.floor(Number(args.minutes) || 10), 1), MAX_MUTE_MINUTES)
        title = `禁言 ${uid} ${minutes} 分钟`
        run = () => tryEach([
          og && ['官方机器人', () => og.muteMember(target, minutes * 60)],
          wg && ['野生号', () => wg.muteMember(target, minutes * 60)]
        ])
        break
      }
      case 'unmute':
        title = `解除 ${uid} 的禁言`
        run = () => tryEach([
          og && ['官方机器人', () => og.muteMember(target, 0)],
          wg && ['野生号', () => wg.muteMember(target, 0)]
        ])
        break
      case 'kick': {
        const block = Boolean(args.reject_add)
        title = `把 ${uid} 踢出群${block ? '并拉黑（不能再加群）' : ''}`
        run = () => tryEach([
          og && ['官方机器人', () => og.kickMember(target, block)],
          wg && ['野生号', () => wildKick(wild, wg, target, block)]
        ])
        break
      }
      case 'blacklist': {
        if (!(await approval.isManager(e))) return '只有主人和本群群主、管理员可以查看群黑名单'
        if (typeof og?.getBlacklist !== 'function') return '只有官方机器人（需要是群管理员）能查看群黑名单，野生号没有这个接口'
        try {
          const list = await og.getBlacklist()
          if (!list.length) return '群黑名单是空的'
          return `群黑名单（${list.length} 人）：\n${list.slice(0, 50).map((u, i) => `${i + 1}. ${u.nickname || ''}（${u.user_id}）`).join('\n')}`
        } catch (err) {
          return `查看群黑名单失败：${explain(err.message)}`
        }
      }
      case 'blacklist_add':
      case 'blacklist_remove': {
        const add = action === 'blacklist_add'
        if (typeof og?.setBlacklist !== 'function') {
          return `只有官方机器人（需要是群管理员）能${add ? '拉黑' : '移出黑名单'}，野生号没有群黑名单接口${add ? '；野生号可以踢人时拉黑（kick + reject_add）' : ''}`
        }
        title = add ? `把 ${uid} 加入群黑名单（不能再加群）` : `把 ${uid} 移出群黑名单`
        run = async () => {
          const ret = await call(() => og.setBlacklist(target, add), '接口返回失败')
          if (ret?.fail_user_ids?.length) throw new Error('开放平台返回这个账号操作失败（对方可能没有绑定 QQ 号，或不在黑名单里）')
        }
        break
      }
      case 'set_card':
        if (needWild()) return needWild()
        title = text ? `把 ${uid} 的群名片改成「${text.slice(0, 60)}」` : `清除 ${uid} 的群名片`
        run = () => call(() => wg.setCard(target, text.slice(0, 60)))
        break
      case 'set_title':
        if (needWild()) return needWild()
        title = text ? `给 ${uid} 设置头衔「${text.slice(0, 18)}」` : `清除 ${uid} 的头衔`
        run = () => call(() => wg.setTitle(target, text.slice(0, 18)))
        break
      case 'mute_all':
      case 'unmute_all':
        if (needWild()) return needWild()
        title = action === 'mute_all' ? '开启全员禁言' : '关闭全员禁言'
        run = () => call(() => wg.muteAll(action === 'mute_all'))
        break
      case 'recall': {
        const bot = adminBot(e)
        if (!bot?.pickGroup) return '没有可以撤回消息的机器人'
        let targets, recallGroup
        try {
          ({ targets, group: recallGroup } = await locateRecall(e, bot, gid, args))
        } catch (err) {
          return `撤回失败：${err.message}`
        }
        if (typeof recallGroup?.recallMsg !== 'function') return '当前机器人不支持撤回消息'

        // 申请确认时把要撤的消息列出来，看清楚再确认
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
    for (const [name, method] of [['set_card', 'setCard'], ['set_title', 'setTitle'], ['mute_all', 'muteAll'], ['unmute_all', 'muteAll']]) {
      if (name === action && typeof wg[method] !== 'function') return '野生号不支持这个群管理操作'
    }
    if (['mute', 'unmute', 'kick'].includes(action) && !og && !wg) return '没有能执行的机器人：官方机器人不是群管理员，这个群里也没有野生号'

    // 结果里只带标题第一行（多条撤回时后面是消息列表）
    const head = title.split('\n')[0].replace(/：$/, '')
    try {
      return await approval.guard(e, {
        title,
        level: 'manager',
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
