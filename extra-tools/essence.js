import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)
const web = await import(pathToFileURL(path.resolve(dir, '_qqweb.js')).href)
const approval = await import(pathToFileURL(path.resolve(dir, '_approval.js')).href)

const preview = text => (text.length > 40 ? `${text.slice(0, 40)}…` : text) || '（无文字）'
const ERRORS = [[/NOT_GROUP_ADMIN|not.*admin|权限|permission/i, '野生号不是群管理员，设置 / 取消精华需要管理员']]
const explain = text => ERRORS.find(([re]) => re.test(text))?.[1] || text

/** 精华消息内容：OneBot 为消息段数组，网页接口为 msg_content；不同协议端的写法不一样，尽量都认 */
function contentText (list) {
  if (typeof list === 'string') return list.replace(/\s+/g, ' ').trim()
  return (Array.isArray(list) ? list : []).map(seg => {
    if (typeof seg === 'string') return seg
    const data = seg?.data && typeof seg.data === 'object' ? seg.data : seg || {}
    const type = seg?.type ?? seg?.msg_type
    if (type === 'text' || type === 1) return data.text ?? ''
    if (type === 'image' || type === 3 || data.image_url || data.file_id) return '[图片]'
    if (type === 'face' || type === 'mface' || type === 2) return '[表情]'
    if (type === 'at') return `@${data.qq ?? data.name ?? ''}`
    if (data.text) return data.text
    return type !== undefined ? `[${type}]` : ''
  }).join('').replace(/\s+/g, ' ').trim()
}

const pick = (o, ...keys) => keys.map(k => o?.[k]).find(v => v !== undefined && v !== null && v !== '')

/** 一条精华统一成 { id, seq, random, senderId, sender, senderTime, operator, time, text, keys } */
function normalize (m) {
  const senderId = String(pick(m, 'sender_id', 'sender_uin', 'user_id') ?? '')
  const nick = pick(m, 'sender_nick', 'sender_name', 'nickname') || ''
  return {
    id: pick(m, 'message_id', 'msg_id'),
    seq: pick(m, 'msg_seq', 'message_seq', 'seq'),
    random: pick(m, 'msg_random', 'random'),
    senderId,
    sender: nick || senderId ? `${nick}${senderId ? `(${senderId})` : ''}` : '',
    senderTime: Number(pick(m, 'sender_time', 'send_time')) || 0,
    operator: pick(m, 'operator_nick', 'add_digest_nick', 'operator_name') || pick(m, 'operator_id', 'add_digest_uin'),
    time: Number(pick(m, 'operator_time', 'add_digest_time', 'sender_time')) || 0,
    text: contentText(pick(m, 'content', 'msg_content', 'message')),
    keys: Object.keys(m || {})
  }
}

/** QQ 网页版的精华列表（带消息内容） */
async function webList (bot, gid) {
  const cred = await web.credentials(bot, 'qun.qq.com')
  const list = []
  for (let page = 0; page < 5; page++) {
    const ret = await web.call(`https://qun.qq.com/cgi-bin/group_digest/digest_list?bkn=${cred.bkn}&group_code=${gid}&page_start=${page}&page_limit=20`, cred)
    for (const m of ret.data?.msg_list || []) list.push(normalize(m))
    if (ret.data?.is_end !== false) break
  }
  return list
}

/**
 * 协议端的列表没带消息内容时（有的只给序号、发送人、设置人等几个字段）补上内容：
 * 先对 QQ 网页版的精华列表（按消息序号，对不上再按同一个发送人、设置时间最接近），再对群消息记录；
 * 都拿不到就保持没有内容，原因记在 list.textError 里
 */
async function fillText (bot, gid, list) {
  const missing = list.filter(i => !i.text)
  if (!missing.length) return
  const errors = []
  try {
    const webItems = (await webList(bot, gid)).filter(w => w.text)
    for (const i of missing) {
      const bySeq = i.seq !== undefined && i.seq !== null && webItems.find(w => String(w.seq) === String(i.seq))
      const near = !bySeq && webItems
        .filter(w => w.senderId && w.senderId === i.senderId && (!i.time || !w.time || Math.abs(w.time - i.time) <= 120))
        .sort((a, b) => Math.abs(a.time - i.time) - Math.abs(b.time - i.time))[0]
      const hit = bySeq || near
      if (hit) {
        i.text = hit.text
        if (i.random === undefined || i.random === null) i.random = hit.random
        if (i.seq === undefined || i.seq === null) i.seq = hit.seq
      }
    }
    if (!webItems.length) errors.push('网页版精华列表是空的')
  } catch (err) {
    errors.push(`网页版精华列表：${err.message}`)
  }
  if (missing.some(i => !i.text)) {
    try {
      for (const m of await chat.fetchHistory(bot, gid, chat.SCAN)) {
        const seqs = [m.real_seq, m.message_seq, m.seq].filter(v => v !== undefined && v !== null).map(String)
        for (const i of missing) if (!i.text && i.seq !== undefined && i.seq !== null && seqs.includes(String(i.seq))) i.text = chat.textOf(m)
      }
    } catch (err) {
      errors.push(`群消息记录：${err.message}`)
    }
  }
  if (missing.some(i => !i.text)) list.textError = errors.join('；') || '按消息序号和发送人都没对上'
}

/** 精华消息列表（每次现查）：OneBot 的 get_essence_msg_list，ICQQ 用网页接口；withText 为 false 时不补内容（只核对在不在） */
async function essenceList (bot, gid, { withText = true } = {}) {
  if (typeof bot.sendApi !== 'function') return await webList(bot, gid)
  const ret = await chat.invoke([[bot, 'sendApi', ['get_essence_msg_list', { group_id: Number(gid) }]]], '查看精华消息')
  const raw = Array.isArray(ret) ? ret : Array.isArray(ret?.list) ? ret.list : []
  const list = raw.map(normalize)
  if (withText) await fillText(bot, gid, list)
  return list
}

/** 能用来取消的精华：有消息 ID，或者有消息序号和随机数（走网页接口） */
const removable = i => (i.id !== undefined && i.id !== null) || (i.seq !== undefined && i.seq !== null && i.random !== undefined && i.random !== null)
const sameItem = (a, b) => (a.id !== undefined && a.id !== null && String(a.id) === String(b.id)) || (a.seq !== undefined && a.seq !== null && String(a.seq) === String(b.seq))

/**
 * 设置 / 取消精华的那条消息：引用了消息时一律是被引用的那条（不管有没有填 user_id / keyword），
 * 否则按发送人 / 关键词找最近一条
 */
async function target (e, bot, gid, args) {
  const userId = String(args.user_id ?? '').replace(/^@/, '').trim()
  const keyword = String(args.keyword ?? '').trim()
  if (e.source) return await chat.quotedMessage(e, bot, gid)
  if (!userId && !keyword) throw new Error('请引用那条消息，或提供 user_id（谁发的）/ keyword（内容关键词）')
  const uid = userId ? await chat.realQQ(e, userId) : ''
  const [m] = await chat.recentMessages(e, bot, gid, { users: uid ? [uid] : null, keyword })
  if (!m) throw new Error(`最近 ${chat.SCAN} 条群消息里没有找到符合条件的消息`)
  return m
}

/**
 * 取消精华的那条：一律落到精华列表里的一条，用列表给的消息 ID（没有时用消息序号）取消（列表每次现查，不缓存）。
 * 没有引用：按序号（list 的显示顺序，1 是最近设置的）/ 发送人 / 关键词在列表里找；
 * 引用了消息：先在群消息记录里找到被引用的那条，再到列表里对——消息 ID → 消息序号 → 同一个人、发送时间最接近的。
 * 只按“[图片]”这类内容去群消息记录里找，同一个人发过几张图时会对错，所以不能直接拿记录里的那条去删。
 */
async function removeTarget (e, bot, gid, args) {
  const all = (await essenceList(bot, gid)).reverse()
  if (!all.length) throw new Error('这个群没有精华消息')
  const list = all.filter(removable)
  if (!list.length) throw new Error(`精华列表里既没有消息 ID 也没有消息序号，取消不了（接口返回的字段：${all[0].keys.join('、')}）`)

  if (!e.source) {
    const index = Math.floor(Number(args.index))
    const userId = String(args.user_id ?? '').replace(/^@/, '').trim()
    const keyword = String(args.keyword ?? '').trim().toLowerCase()
    if (index) {
      if (!list[index - 1]) throw new Error(`精华列表只有 ${list.length} 条，没有第 ${index} 条`)
      return list[index - 1]
    }
    if (!userId && !keyword) throw new Error('请引用那条精华消息，或说明是精华列表里的第几条（index）/ 谁发的（user_id）/ 内容关键词（keyword）')
    const uid = userId ? await chat.realQQ(e, userId) : ''
    const hit = list.find(i => (!uid || i.senderId === String(uid)) && (!keyword || i.text.toLowerCase().includes(keyword)))
    if (!hit) throw new Error('精华列表里没有找到符合条件的精华消息')
    return hit
  }

  const m = await chat.quotedMessage(e, bot, gid).catch(() => null)
  const byId = m && list.find(i => String(i.id) === String(m.message_id))
  if (byId) return byId
  const seqs = [m?.real_seq, m?.message_seq, m?.seq, m?.msg_seq].filter(v => v !== undefined && v !== null).map(String)
  const bySeq = seqs.length && list.find(i => i.seq !== undefined && i.seq !== null && seqs.includes(String(i.seq)))
  if (bySeq) return bySeq
  const quotedSender = /^\d{5,12}$/.test(String(e.source.user_id ?? '')) ? String(e.source.user_id) : ''
  const sender = (m && chat.senderOf(m)) || quotedSender
  const time = Number(m?.time ?? e.source.time) || 0
  const same = list.filter(i => sender && i.senderId === sender)
  if (same.length === 1) return same[0]
  if (same.length > 1 && time) return same.sort((a, b) => Math.abs(a.senderTime - time) - Math.abs(b.senderTime - time))[0]
  throw new Error(`被引用的消息不在精华列表里（可能已经不是精华了）；精华列表共 ${list.length} 条，可以用 index 指定第几条`)
}

/** QQ 网页版的取消精华（按消息序号），协议端的 delete_essence_msg 失败时用 */
async function webCancel (bot, gid, item) {
  const cred = await web.credentials(bot, 'qun.qq.com')
  await web.call(`https://qun.qq.com/cgi-bin/group_digest/cancel_digest?bkn=${cred.bkn}&group_code=${gid}&msg_seq=${item.seq}&msg_random=${item.random}`, cred)
}

/** 取消后还在不在精华列表里（按消息 ID 或序号对）；查不了列表时当作还在 */
async function stillEssence (bot, gid, item) {
  const list = await essenceList(bot, gid, { withText: false }).catch(() => null)
  return !list || list.some(i => sameItem(i, item))
}

/**
 * 取消一条精华：有消息 ID 先用协议端的接口，失败或没有 ID 时用 QQ 网页版按序号取消；
 * 接口报错时再查一次列表，确实不在了就算已经取消。返回 true 为取消了，'gone' 为本来就不是精华了
 */
async function removeEssence (bot, gid, item) {
  let first
  if (item.id !== undefined && item.id !== null) {
    try {
      await chat.invoke([[bot, 'removeEssenceMessage', [item.id]], [bot, 'sendApi', ['delete_essence_msg', { message_id: item.id }]]], '取消精华')
      return true
    } catch (err) {
      first = err
      if (!(await stillEssence(bot, gid, item))) return 'gone'
    }
  }
  if (item.seq === undefined || item.seq === null || item.random === undefined || item.random === null) throw new Error(explain(first.message))
  try {
    await webCancel(bot, gid, item)
  } catch (err) {
    throw new Error(first ? `${explain(first.message)}；网页接口也失败：${err.message}` : err.message)
  }
  if (await stillEssence(bot, gid, item)) throw new Error(`${first ? `${explain(first.message)}；` : ''}网页接口返回成功，但精华列表里还有这条`)
  return true
}

export class EssenceTool extends CustomTool {
  name = 'essence'

  function = {
    name: 'essence',
    description: '群精华消息（需要同群的野生号）：查看精华消息列表（list）、把一条消息设为精华（set）、取消精华（remove）。' +
      '设置 / 取消时：用户引用了消息就是被引用的那条，直接调用、不要填 user_id / keyword（工具会自己读取引用，看不到引用内容也直接调用，图片也一样）；' +
      '没有引用时用 user_id / keyword 找最近一条；取消精华还可以用 index（list 里的序号，1 是最近设置的），取消时工具会到精华列表里核对是哪一条。需要野生号是管理员。' +
      '主人、群主、管理员要求时直接执行；其他人要求设置 / 取消时会 @ 主人申请确认（主人、群主、管理员都能确认，告诉用户等确认即可）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'set', 'remove'],
          description: 'list=精华列表（默认）；set=设为精华；remove=取消精华'
        },
        user_id: {
          type: 'string',
          description: 'set / remove 时按发送人找最近一条消息（没有引用时用）'
        },
        keyword: {
          type: 'string',
          description: 'set / remove 时按内容关键词找最近一条消息（没有引用时用）'
        },
        index: {
          type: 'number',
          description: 'remove 时按精华列表的序号取消（list 显示的序号，1 是最近设置的）'
        },
        limit: {
          type: 'number',
          description: 'list 时显示几条，默认 10，最多 50'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '拿不到当前消息'
    if (!e.isGroup && !e.group_id) return '只能在群里使用'
    try {
      const gid = String(e.group_id)
      const bot = grp.requireWild(e, gid)

      if (args.action === 'set' || args.action === 'remove') {
        const set = args.action === 'set'
        // 取消精华：落到精华列表里的一条（ICQQ 没有带 ID 的列表，按群消息记录找）
        const hit = set ? null : await removeTarget(e, bot, gid, args)
        const m = hit ? null : await target(e, bot, gid, args)
        const desc = hit
          ? `${hit.sender || '未知'}：${preview(hit.text)}`
          : `${m.sender?.card || m.sender?.nickname || ''}(${chat.senderOf(m)})：${preview(chat.textOf(m))}`
        return await approval.guard(e, {
          level: 'manager',
          title: `${set ? '把这条消息设为精华' : '取消这条消息的精华'}：${desc}`,
          run: async () => {
            if (hit) {
              return (await removeEssence(bot, gid, hit)) === 'gone' ? `这条消息已经不是精华了：${desc}` : `已取消精华：${desc}`
            }
            try {
              await chat.invoke(set
                ? [[bot, 'setEssenceMessage', [m.message_id]], [bot, 'sendApi', ['set_essence_msg', { message_id: m.message_id }]]]
                : [[bot, 'removeEssenceMessage', [m.message_id]], [bot, 'sendApi', ['delete_essence_msg', { message_id: m.message_id }]]],
              set ? '设置精华' : '取消精华')
            } catch (err) {
              throw new Error(explain(err.message))
            }
            return `已${set ? '设为精华' : '取消精华'}：${desc}`
          }
        })
      }

      const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 10, 1), 50)
      const list = (await essenceList(bot, gid)).reverse()
      if (!list.length) return '这个群还没有精华消息'
      const lines = list.slice(0, limit).map((m, i) => {
        const extra = [m.operator && `${m.operator} 设置`, m.time && grp.time(m.time)].filter(Boolean).join('，')
        return `${i + 1}. ${m.sender || '未知'}：${preview(m.text)}${extra ? `（${extra}）` : ''}`
      })
      // 发送人、内容都没解析出来：多半是协议端的字段名不一样，把字段名带上方便排查
      const unknown = list.every(m => !m.sender && !m.text)
        ? `\n（没有解析出发送人和内容，接口返回的字段：${list[0].keys.join('、')}）`
        : list.every(m => !m.text) ? `\n（协议端的精华列表不带消息内容，补内容也没成功：${list.textError || '原因未知'}）` : ''
      return `共 ${list.length} 条精华消息${list.length > limit ? `，显示最近 ${limit} 条` : ''}（序号可以用于取消，1 是最近设置的）：\n${lines.join('\n')}${unknown}`
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new EssenceTool()
