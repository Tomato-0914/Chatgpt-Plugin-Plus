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

/** 私聊发送：与对方是好友的野生号 → 当前机器人（官方机器人发不出时由 QQBot-Plugin 交给野生号）→ 同群野生号发临时会话 */
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

/** 发到别的群：在群里的当前机器人（官方机器人发不出时由 QQBot-Plugin 交给野生号）→ 同群的野生号 */
async function sendGroup (e, gid, msg) {
  const attempts = []
  if (typeof e.bot?.pickGroup === 'function' && (inGroup(e.bot, gid) || !chat.isWildBot(e.bot))) {
    attempts.push(['当前机器人', () => e.bot.pickGroup(chat.asId(gid)).sendMsg(msg)])
  }
  const wild = chat.wildInGroup(gid)
  if (wild && wild !== e.bot) attempts.push([`野生号（${wild.uin}）`, () => wild.pickGroup(Number(gid)).sendMsg(msg)])
  if (!attempts.length) throw new Error('机器人不在这个群里')
  return await trySend(attempts)
}

function build (text, image) {
  const msg = []
  if (text) msg.push(text)
  if (image) msg.push({ type: 'image', file: image })
  return msg
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
  for (const m of picked) msg.push({ type: 'at', qq: chat.asId(m.user_id) }, ' ')
  const text = String(args.text ?? '').trim().slice(0, MAX_TEXT)
  if (text) msg.push(text)
  const ret = await e.reply(msg)
  if (!chat.sent(ret)) return `发送失败：${chat.failReason(ret)}`
  return `已经随机 @ 了：${picked.map(grp.line).join('、')}，不需要再重复`
}

export class SendMessageTool extends CustomTool {
  name = 'send_message'

  function = {
    name: 'send_message',
    description: '替用户发消息：私聊转告主人（to_master）、私聊发给某人（private）、发到某个群（group）、在当前群随机 @ 几个人（random_at）。' +
      '在当前聊天里回复不需要用这个工具，直接回答即可；在群里 @ 指定的人用 at_user。' +
      '群友让机器人私聊别人、或往别的群发消息时，需要主人确认后才会发出。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['to_master', 'private', 'group', 'random_at'],
          description: 'to_master=转告主人（默认）；private=私聊某人；group=发到某个群；random_at=当前群随机 @ 人'
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

      const text = String(args.text ?? '').trim()
      if (text.length > MAX_TEXT) return `内容太长了，最多 ${MAX_TEXT} 字`
      const image = String(args.image_url ?? '').trim()
      if (image && !/^https?:\/\//i.test(image)) return '图片地址只支持 http / https'
      if (!text && !image) return '请提供要发的内容'

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
          const ret = await e.reply(build(text, image))
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
