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
      list.push({ sender: `${m.sender_nick || ''}(${m.sender_uin})`, operator: m.add_digest_nick || m.add_digest_uin, time: m.add_digest_time || m.sender_time, text: contentText(m.msg_content) })
    }
    if (ret.data?.is_end !== false) break
  }
  return list
}

/** 设置 / 取消精华的那条消息：引用的消息，或按发送人 / 关键词找最近一条 */
async function target (e, bot, gid, args) {
  const userId = String(args.user_id ?? '').replace(/^@/, '').trim()
  const keyword = String(args.keyword ?? '').trim()
  if (e.source && !userId && !keyword) return await chat.quotedMessage(e, bot, gid)
  if (!userId && !keyword) throw new Error('请引用那条消息，或提供 user_id（谁发的）/ keyword（内容关键词）')
  const uid = userId ? await chat.realQQ(e, userId) : ''
  const [m] = await chat.recentMessages(e, bot, gid, { users: uid ? [uid] : null, keyword })
  if (!m) throw new Error(`最近 ${chat.SCAN} 条群消息里没有找到符合条件的消息`)
  return m
}

export class EssenceTool extends CustomTool {
  name = 'essence'

  function = {
    name: 'essence',
    description: '群精华消息（需要同群的野生号）：查看精华消息列表（list）、把一条消息设为精华（set）、取消精华（remove）。' +
      '设置 / 取消时引用那条消息（工具会自己读取引用，看不到引用内容也直接调用），或用 user_id / keyword 找最近一条；需要野生号是管理员。' +
      '主人要求时直接执行；其他人要求设置 / 取消时会 @ 主人申请确认（告诉用户等主人确认即可）。',
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
        const m = await target(e, bot, gid, args)
        const desc = `${m.sender?.card || m.sender?.nickname || ''}(${chat.senderOf(m)})：${preview(chat.textOf(m))}`
        return await approval.guard(e, {
          title: `${set ? '把这条消息设为精华' : '取消这条消息的精华'}：${desc}`,
          run: async () => {
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
