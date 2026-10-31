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

/** 精华消息内容：OneBot 为消息段数组，网页接口为 msg_content */
function contentText (list) {
  return (Array.isArray(list) ? list : []).map(seg => {
    const data = seg?.data && typeof seg.data === 'object' ? seg.data : seg
    if (seg?.type === 'text' || seg?.msg_type === 1) return data.text ?? ''
    if (seg?.type === 'image' || seg?.msg_type === 3) return '[图片]'
    if (seg?.type === 'face' || seg?.msg_type === 2) return '[表情]'
    if (seg?.type === 'at') return `@${data.qq ?? ''}`
    return seg?.type ? `[${seg.type}]` : ''
  }).join('').replace(/\s+/g, ' ').trim()
}

/** 精华消息列表：OneBot 的 get_essence_msg_list，ICQQ 用网页接口 */
async function essenceList (bot, gid) {
  if (typeof bot.sendApi === 'function') {
    const ret = await chat.invoke([[bot, 'sendApi', ['get_essence_msg_list', { group_id: Number(gid) }]]], '查看精华消息')
    return (Array.isArray(ret) ? ret : []).map(m => ({
      id: m.message_id,
      seq: m.msg_seq ?? m.message_seq,
      random: m.msg_random,
      senderTime: Number(m.sender_time) || 0,
      senderId: String(m.sender_id ?? ''),
      sender: `${m.sender_nick || ''}(${m.sender_id})`,
      operator: m.operator_nick || m.operator_id,
      time: m.operator_time || m.sender_time,
      text: contentText(m.content)
    }))
  }
  const cred = await web.credentials(bot, 'qun.qq.com')
  const list = []
  for (let page = 0; page < 5; page++) {
    const ret = await web.call(`https://qun.qq.com/cgi-bin/group_digest/digest_list?bkn=${cred.bkn}&group_code=${gid}&page_start=${page}&page_limit=20`, cred)
    for (const m of ret.data?.msg_list || []) {
      list.push({ senderId: String(m.sender_uin ?? ''), sender: `${m.sender_nick || ''}(${m.sender_uin})`, operator: m.add_digest_nick || m.add_digest_uin, time: m.add_digest_time || m.sender_time, text: contentText(m.msg_content) })
    }
    if (ret.data?.is_end !== false) break
  }
  return list
}

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
 * 取消精华的那条：一律落到精华列表里的一条，用列表给的消息 ID 删（列表每次现查，不缓存）。
 * 没有引用：按序号（list 的显示顺序，1 是最近设置的）/ 发送人 / 关键词在列表里找；
 * 引用了消息：先在群消息记录里找到被引用的那条，再到列表里对——消息 ID → 消息序号 → 同一个人、发送时间最接近的。
 * 只按“[图片]”这类内容去群消息记录里找，同一个人发过几张图时会对错，所以不能直接拿记录里的那条去删。
 * 只有 OneBot 的列表带消息 ID；ICQQ 返回 null，交给群消息记录找
 */
async function removeTarget (e, bot, gid, args) {
  if (typeof bot.sendApi !== 'function') return null
  const list = (await essenceList(bot, gid)).filter(m => m.id !== undefined && m.id !== null).reverse()
  if (!list.length) throw new Error('这个群没有精华消息（或精华列表里没有消息 ID）')

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
  const seqs = [m?.real_seq, m?.message_seq, m?.seq].filter(v => v !== undefined && v !== null).map(String)
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

/** 取消后还在不在精华列表里（接口报“已被移除”时用来确认） */
async function stillEssence (bot, gid, id) {
  return (await essenceList(bot, gid).catch(() => [])).some(i => String(i.id) === String(id))
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
        const m = hit ? { message_id: hit.id } : await target(e, bot, gid, args)
        const desc = hit
          ? `${hit.sender}：${preview(hit.text)}`
          : `${m.sender?.card || m.sender?.nickname || ''}(${chat.senderOf(m)})：${preview(chat.textOf(m))}`
        return await approval.guard(e, {
          level: 'manager',
          title: `${set ? '把这条消息设为精华' : '取消这条消息的精华'}：${desc}`,
          run: async () => {
            try {
              await chat.invoke(set
                ? [[bot, 'setEssenceMessage', [m.message_id]], [bot, 'sendApi', ['set_essence_msg', { message_id: m.message_id }]]]
                : [[bot, 'removeEssenceMessage', [m.message_id]], [bot, 'sendApi', ['delete_essence_msg', { message_id: m.message_id }]]],
              set ? '设置精华' : '取消精华')
            } catch (err) {
              if (set || !hit) throw new Error(explain(err.message))
              // 取消失败：再查一次列表，确实不在了就当已经取消（接口有时报“已被移除精华”）
              if (!(await stillEssence(bot, gid, hit.id))) return `这条消息已经不是精华了：${desc}`
              // 还在：协议端按消息 ID 取消不一定成功，改用 QQ 网页版按消息序号取消
              if (hit.seq === undefined || hit.seq === null || hit.random === undefined || hit.random === null) throw new Error(explain(err.message))
              try {
                await webCancel(bot, gid, hit)
              } catch (err2) {
                throw new Error(`${explain(err.message)}；网页接口也失败：${err2.message}`)
              }
              if (await stillEssence(bot, gid, hit.id)) throw new Error(`${explain(err.message)}；网页接口返回成功，但精华列表里还有这条`)
            }
            return `已${set ? '设为精华' : '取消精华'}：${desc}`
          }
        })
      }

      const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 10, 1), 50)
      const list = await essenceList(bot, gid)
      if (!list.length) return '这个群还没有精华消息'
      const lines = list.slice(-limit).reverse().map((m, i) =>
        `${i + 1}. ${m.sender}：${preview(m.text)}${m.operator ? `（${m.operator} 设置${m.time ? `，${grp.time(m.time)}` : ''}）` : ''}`)
      return `共 ${list.length} 条精华消息${list.length > limit ? `，显示最近 ${limit} 条` : ''}：\n${lines.join('\n')}`
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new EssenceTool()
