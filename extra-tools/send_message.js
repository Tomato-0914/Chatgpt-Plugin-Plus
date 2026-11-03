import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)
const approval = await import(pathToFileURL(path.resolve(dir, '_approval.js')).href)

const MAX_TEXT = 1000
const MAX_AT = 5
/** 群友给主人留言的间隔 */
const MASTER_COOLDOWN = 60 * 1000
const lastToMaster = (globalThis[Symbol.for('chatgpt-extra-tools-to-master')] ??= new Map())

const isQQ = id => /^\d{5,12}$/.test(String(id ?? ''))
const preview = text => (text.length > 30 ? `${text.slice(0, 30)}…` : text) || '（图片）'
const nameOf = e => e.sender?.card || e.sender?.nickname || ''
const where = e => (e.isGroup || e.group_id ? `群 ${e.group_name || e.group?.name || e.group_id}` : '私聊')
const inGroup = (bot, gid) => bot?.gl?.has?.(Number(gid)) || bot?.gl?.has?.(String(gid))

/** 依次尝试几种发送方式，发出去一种就停；都失败时抛出所有原因 */
async function trySend (attempts) {
  const errors = []
  for (const [label, fn] of attempts) {
    try {
      const ret = await fn()
      if (chat.sent(ret)) return label
      errors.push(`${label}：${chat.failReason(ret)}`)
    } catch (err) {
      errors.push(`${label}：${err?.message || err}`)
    }
  }
  throw new Error(errors.join('；') || '没有可以发送的机器人')
}

/** 私聊发送：与对方是好友的其他协议机器人 → 当前机器人（官方机器人发不出时由 Cheshire-Plugin 交给其他协议机器人）→ 同群的其他协议机器人发临时会话 */
async function sendPrivate (e, uid, msg) {
  const attempts = []
  const bots = [...new Set([...(globalThis.Bot?.uin || [])].map(id => globalThis.Bot[id]))].filter(Boolean)
  const friend = isQQ(uid) && [e.bot, ...bots].find(b => chat.isWildBot(b) && (b.fl?.has?.(Number(uid)) || b.fl?.has?.(String(uid))))
  if (friend) attempts.push([`好友私聊（${friend.uin}）`, () => friend.pickFriend(Number(uid)).sendMsg(msg)])
  if (e.bot !== friend && typeof e.bot?.pickFriend === 'function') attempts.push(['当前机器人私聊', () => e.bot.pickFriend(chat.asId(uid)).sendMsg(msg)])
  const gid = e.isGroup || e.group_id ? e.group_id : null
  const temp = gid && isQQ(uid) && grp.wildFor(e, gid)
  if (temp && temp !== friend) attempts.push(['群临时会话', () => temp.pickMember(Number(gid), Number(uid)).sendMsg(msg)])
  return await trySend(attempts)
}

/** 发到别的群：在群里的当前机器人（官方机器人发不出时由 Cheshire-Plugin 交给其他协议机器人）→ 同群的其他协议机器人 */
async function sendGroup (e, gid, msg) {
  const attempts = []
  if (typeof e.bot?.pickGroup === 'function' && (inGroup(e.bot, gid) || !chat.isWildBot(e.bot))) {
    attempts.push(['当前机器人', () => e.bot.pickGroup(chat.asId(gid)).sendMsg(msg)])
  }
  const wild = chat.wildInGroup(gid)
  if (wild && wild !== e.bot) attempts.push([`其他协议机器人（${wild.uin}）`, () => wild.pickGroup(Number(gid)).sendMsg(msg)])
  if (!attempts.length) throw new Error('机器人不在这个群里')
  return await trySend(attempts)
}

const isOfficial = bot => bot?.adapter?.id === 'QQBot'

/** 消息：文字（markdown 为 true 且是官方机器人时发 Markdown，其他机器人发普通文字）+ 图片 */
function build (text, image, { markdown = false, bot } = {}) {
  const msg = []
  if (text) msg.push(markdown && isOfficial(bot) ? { type: 'markdown', data: text } : text)
  if (image) msg.push({ type: 'image', file: image })
  return msg
}

/** OneBot 写法 { type, data: {...} } 和云崽写法 { type, ...字段 } 都认，统一成云崽写法 */
function normalizeSegments (list) {
  if (!Array.isArray(list) || !list.length) throw new Error('segments 要是消息段数组，如 [{"type":"text","text":"你好"}]')
  if (list.length > 20) throw new Error('消息段最多 20 个')
  return list.map(seg => {
    if (typeof seg === 'string') return seg
    if (!seg || typeof seg !== 'object' || !seg.type) throw new Error('每个消息段都要有 type')
    const { type, data, ...rest } = seg
    return data && typeof data === 'object' && !Array.isArray(data) ? { type, ...data, ...rest } : { type, ...(data !== undefined ? { data } : {}), ...rest }
  })
}

/** 不重复地随机取 n 个 */
function sample (list, n) {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1)
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

/**
 * 发原始消息段（主人级：消息段可以拼出各种卡片、伪造转发等，只有主人能直接发，别人要主人确认）
 * 发到 group_id / user_id，都不填时发到当前聊天
 */
async function raw (e, args) {
  const msg = normalizeSegments(args.segments)
  const gid = String(args.group_id ?? '').trim()
  const uid = String(args.user_id ?? '').trim()
  const types = [...new Set(msg.map(m => (typeof m === 'string' ? 'text' : m.type)))].join('、')
  const target = gid ? `群 ${gid}` : uid ? `私聊 ${uid}` : '当前聊天'
  const run = async () => {
    if (gid) return `已发到群 ${gid}（${await sendGroup(e, gid, msg)}）`
    if (uid) return `已私聊发给 ${uid}（${await sendPrivate(e, uid, msg)}）`
    const ret = await e.reply(msg)
    if (!chat.sent(ret)) throw new Error(chat.failReason(ret))
    return '已经发到当前聊天，不需要再重复发送'
  }
  return await approval.guard(e, { title: `往${target}发原始消息段（${types}）`, run })
}

async function toMaster (e, text, image, all) {
  const list = await approval.masterList(e)
  if (!list.length) return '没有配置主人'
  if (!e.isMaster) {
    const last = lastToMaster.get(String(e.user_id)) || 0
    if (Date.now() - last < MASTER_COOLDOWN) return '刚给主人发过消息，请过一分钟再发'
  }
  const head = e.isMaster ? '' : `📨 ${where(e)}的 ${nameOf(e)}（${e.user_id}）让我转告：\n`
  const msg = build(`${head}${text}`.trim(), image)
  const done = []
  const failed = []
  for (const id of all ? list : list.slice(0, 1)) {
    try {
      await sendPrivate(e, id, msg)
      done.push(id)
    } catch (err) {
      failed.push(`${id}（${err.message}）`)
    }
  }
  if (done.length && !e.isMaster) lastToMaster.set(String(e.user_id), Date.now())
  if (!done.length) return `发送给主人失败：${failed.join('；')}`
  return `已经私聊发给主人 ${done.join('、')}${failed.length ? `，发送失败：${failed.join('；')}` : ''}，不需要再重复发送`
}

async function random (e, args) {
  if (!e.isGroup && !e.group_id) return '只能在群里随机 @ 人'
  const bots = grp.botIds(e)
  const list = (await grp.requireMembers(e.group)).filter(m =>
    !bots.has(String(m.user_id)) &&
    !(args.exclude_admin && (m.role === 'owner' || m.role === 'admin')) &&
    !(args.exclude_self && String(m.user_id) === String(e.user_id)))
  if (!list.length) return '没有符合条件的群成员可以 @'
  const picked = sample(list, Math.min(Math.max(Math.floor(Number(args.count)) || 1, 1), MAX_AT, list.length))
  const msg = []
  const unbound = []
  for (const m of picked) {
    const { seg, real } = await chat.mention(e, m.user_id, grp.nameOf(m))
    msg.push(seg)
    if (real) msg.push(' ')
    else unbound.push(grp.nameOf(m))
  }
  const text = String(args.text ?? '').trim().slice(0, MAX_TEXT)
  if (text) msg.push(text)
  const ret = await e.reply(msg)
  if (!chat.sent(ret)) return `发送失败：${chat.failReason(ret)}`
  return `已经随机 @ 了：${picked.map(grp.line).join('、')}${unbound.length ? `（其中 ${unbound.join('、')} 没有绑定 QQ 号，官方机器人 @ 不到，只写了名字，对方收不到提醒）` : ''}，不需要再重复`
}

export class SendMessageTool extends CustomTool {
  name = 'send_message'

  function = {
    name: 'send_message',
    description: '替用户发消息：私聊转告主人（to_master）、私聊发给某人（private）、发到某个群（group）、在当前群随机 @ 几个人（random_at）、' +
      '在当前聊天里先发一条（reply，可 @ 说话的人、引用原消息；一轮里要先回一句再继续用工具时用，平时直接回答即可）、发原始消息段（raw，主人级）。' +
      'markdown=true 时文字按 Markdown 发（只有官方机器人支持，其他机器人按普通文字发）。在群里 @ 指定的人用 at_user。' +
      '群友让机器人私聊别人、或往别的群发消息、发原始消息段时，需要主人确认后才会发出。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['to_master', 'private', 'group', 'random_at', 'reply', 'raw'],
          description: 'to_master=转告主人（默认）；private=私聊某人；group=发到某个群；random_at=当前群随机 @ 人；reply=在当前聊天先发一条；raw=发原始消息段'
        },
        text: {
          type: 'string',
          description: '要发的内容（random_at 时为 @ 后面跟的话）'
        },
        image_url: {
          type: 'string',
          description: '附带的图片地址（可选，http / https）'
        },
        user_id: {
          type: 'string',
          description: 'action=private 时对方的 QQ 号，不填为发给当前说话的人'
        },
        group_id: {
          type: 'string',
          description: 'action=group 时的群号，不填为当前群'
        },
        all_masters: {
          type: 'boolean',
          description: 'action=to_master 时是否发给所有主人，默认只发给第一个主人'
        },
        count: {
          type: 'number',
          description: 'action=random_at 时 @ 几个人，默认 1，最多 5'
        },
        exclude_admin: {
          type: 'boolean',
          description: 'action=random_at 时排除群主和管理员'
        },
        exclude_self: {
          type: 'boolean',
          description: 'action=random_at 时排除说话的人自己'
        },
        markdown: {
          type: 'boolean',
          description: 'reply / group（当前群）时文字按 Markdown 发，只有官方机器人支持'
        },
        at_sender: {
          type: 'boolean',
          description: 'action=reply 时在群里 @ 说话的人'
        },
        quote: {
          type: 'boolean',
          description: 'action=reply 时引用说话的人这条消息'
        },
        segments: {
          type: 'array',
          description: 'action=raw 时的消息段数组，如 [{"type":"text","text":"你好"},{"type":"image","file":"https://..."}]，也认 OneBot 的 {"type","data"} 写法；最多 20 个',
          items: { type: 'object' }
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '拿不到当前消息'
    try {
      if (args.action === 'random_at') return await random(e, args)
      if (args.action === 'raw') return await raw(e, args)

      const text = String(args.text ?? '').trim()
      if (text.length > MAX_TEXT) return `内容太长了，最多 ${MAX_TEXT} 字`
      const image = String(args.image_url ?? '').trim()
      if (image && !/^https?:\/\//i.test(image)) return '图片地址只支持 http / https'
      if (!text && !image) return '请提供要发的内容'

      const markdown = args.markdown === true
      if (args.action === 'reply') {
        // 在当前聊天里回一条（可 @ 说话的人、引用原消息）：一轮对话里要先发一句、再继续用别的工具时用
        const msg = build(text, image, { markdown, bot: e.bot })
        if (args.at_sender && (e.isGroup || e.group_id)) msg.unshift({ type: 'at', qq: chat.asId(e.user_id) }, ' ')
        const ret = await e.reply(msg, args.quote === true)
        if (!chat.sent(ret)) return `发送失败：${chat.failReason(ret)}`
        return `已经发到当前聊天${markdown && !isOfficial(e.bot) ? '（当前不是官方机器人，按普通文字发送）' : ''}，不需要再重复发送`
      }

      if (args.action === 'private') {
        const uid = chat.targetUser(e, args.user_id)
        const self = uid === String(e.user_id)
        const head = e.isMaster || self ? '' : `📨 ${where(e)}的 ${nameOf(e)}（${e.user_id}）让我转告：\n`
        const run = async () => `已私聊发给 ${uid}（${await sendPrivate(e, uid, build(`${head}${text}`.trim(), image))}），不需要再重复发送`
        if (self) return await run()
        return await approval.guard(e, { title: `私聊 ${uid} 发送：${preview(text)}`, run })
      }

      if (args.action === 'group') {
        const current = e.isGroup || e.group_id ? String(e.group_id) : ''
        const gid = String(args.group_id ?? '').trim() || current
        if (!gid) return '请提供群号'
        if (gid === current) {
          const ret = await e.reply(build(text, image, { markdown, bot: e.bot }))
          return chat.sent(ret) ? '已经发到当前群，不需要再重复发送' : `发送失败：${chat.failReason(ret)}`
        }
        if (!isQQ(gid)) return `群号格式不对：${gid}`
        const head = e.isMaster ? '' : `📨 ${where(e)}的 ${nameOf(e)}（${e.user_id}）让我转告：\n`
        const run = async () => `已发到群 ${gid}（${await sendGroup(e, gid, build(`${head}${text}`.trim(), image))}），不需要再重复发送`
        return await approval.guard(e, { title: `往群 ${gid} 发送：${preview(text)}`, run })
      }

      return await toMaster(e, text, image, args.all_masters === true)
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new SendMessageTool()
