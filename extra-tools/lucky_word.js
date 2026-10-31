import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)
const web = await import(pathToFileURL(path.resolve(dir, '_qqweb.js')).href)

const API = 'https://qun.qq.com/v2/luckyword/proxy/domain/qun.qq.com/cgi-bin/group_lucky_word'
const QNAME = { 'qname-service': '976321:131072', 'qname-space': 'Production' }
/** 今天已经抽过 */
const DRAWN = 11004

const word = w => {
  const info = w?.word_info || w || {}
  return { id: String(info.word_id ?? w?.word_id ?? ''), text: info.wording || info.word || w?.wording || '', desc: info.word_desc || w?.word_desc || '' }
}

async function post (bot, action, body) {
  const cred = await web.credentials(bot, 'qun.qq.com')
  return await web.request(`${API}/${action}?bkn=${cred.bkn}`, { cookie: cred.cookie, method: 'POST', headers: QNAME, body })
}

async function words (bot, gid) {
  const ret = await post(bot, 'word_list', { group_code: String(gid), start: 0, limit: 100, need_equip_info: true })
  const error = web.failure(ret)
  if (error) throw new Error(error)
  const data = ret.data || ret
  return { list: (data.word_list || []).map(word), equipped: data.equip_info ? word(data.equip_info) : null }
}

export class LuckyWordTool extends CustomTool {
  name = 'lucky_word'

  function = {
    name: 'lucky_word',
    description: 'QQ 群幸运字符（机器人自己账号的，需要同群的野生号）：查看机器人拥有和正在佩戴的字符（list）、' +
      '每天抽一次字符（draw）、佩戴某个字符（equip）。开关本群幸运字符功能的 QQ 接口已经下线，做不了，用户要求时告诉他在 QQ 群设置里手动开关。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'draw', 'equip'],
          description: 'list=字符列表（默认）；draw=抽字符；equip=佩戴字符'
        },
        word: {
          type: 'string',
          description: 'action=equip 时要佩戴的字符文字或 word_id（从 list 里拿）'
        },
        group_id: {
          type: 'string',
          description: '群号，不填为当前群；其他群仅主人可用'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '拿不到当前消息'
    try {
      const { gid } = grp.target(e, args.group_id)
      const bot = grp.requireWild(e, gid)

      if (args.action === 'draw') {
        const ret = await post(bot, 'draw_lottery', { group_code: String(gid) })
        if (ret?.retcode === DRAWN) return '机器人今天已经抽过幸运字符了，明天再来'
        const error = web.failure(ret)
        if (error) throw new Error(error)
        const w = word(ret.data?.word_info || ret.data)
        return w.text ? `抽到了幸运字符「${w.text}」${w.desc ? `：${w.desc}` : ''}` : '抽过了，但这次没有抽到字符'
      }

      if (args.action === 'equip') {
        const want = String(args.word ?? '').trim()
        if (!want) return '请告诉我要佩戴哪个字符'
        const { list } = await words(bot, gid)
        const w = list.find(i => i.id === want) || list.find(i => i.text === want) || list.find(i => i.text.includes(want))
        if (!w) return `机器人没有字符“${want}”，现有：${list.map(i => i.text).join('、') || '无'}`
        const ret = await post(bot, 'equip', { group_code: String(gid), word_id: w.id })
        const error = web.failure(ret)
        if (error) throw new Error(error)
        return `已佩戴幸运字符「${w.text}」`
      }

      const { list, equipped } = await words(bot, gid)
      if (!list.length) return '机器人在这个群还没有幸运字符（可以用 draw 抽一个）'
      const lines = list.map((w, i) => `${i + 1}. 「${w.text}」${w.desc ? ` ${w.desc}` : ''}${equipped?.id === w.id ? ' （佩戴中）' : ''}`)
      return `机器人有 ${list.length} 个幸运字符${equipped?.text ? `，正在佩戴「${equipped.text}」` : ''}：\n${lines.join('\n')}`
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new LuckyWordTool()
