import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)
const web = await import(pathToFileURL(path.resolve(dir, '_qqweb.js')).href)

const REPORT = 'https://qun.qq.com/m/qun/activedata/proxy/domain/qun.qq.com/cgi-bin/manager/report'
const QNAME = { 'qname-service': '976321:131072', 'qname-space': 'Production' }

/**
 * 群荣誉：OneBot 的 get_group_honor_info 字段（xxx_list），以及群荣誉网页里的字段（网页 type 参数、列表名）
 */
const HONORS = {
  talkative: { label: '龙王', type: 1, onebot: 'talkative_list', page: ['talkativeList'] },
  performer: { label: '群聊之火', type: 2, onebot: 'performer_list', page: ['actorList', 'performerList'] },
  legend: { label: '群聊炽焰', type: 3, onebot: 'legend_list', page: ['legendList'] },
  strong_newbie: { label: '冒尖小春笋', type: 5, onebot: 'strong_newbie_list', page: ['strongnewbieList', 'strongNewbieList', 'newbieList'] },
  emotion: { label: '快乐源泉', type: 6, onebot: 'emotion_list', page: ['emotionList'] }
}

const person = p => ({
  user_id: p?.user_id ?? p?.uin,
  name: p?.nickname || p?.name || p?.nick || '',
  desc: p?.description || p?.desc || '',
  days: p?.day_count ?? p?.dayCount
})

/** 一种荣誉的当前龙王（只有龙王有）和获得者列表；先用协议端的接口，没有时读群荣誉网页 */
async function honorOf (bot, gid, key) {
  const h = HONORS[key]
  const group = bot.pickGroup?.(Number(gid))
  if (typeof group?.getHonorInfo === 'function') {
    try {
      const ret = await group.getHonorInfo(key)
      const data = ret?.data ?? ret
      if (Array.isArray(data?.[h.onebot]) || data?.current_talkative) {
        return {
          current: key === 'talkative' && data.current_talkative ? person(data.current_talkative) : null,
          list: (data[h.onebot] || []).map(person)
        }
      }
    } catch {}
  }
  const state = await web.honorPage(await web.credentials(bot, 'qun.qq.com'), gid, h.type)
  const list = h.page.map(k => state[k]).find(Array.isArray) || []
  return {
    current: key === 'talkative' && state.currentTalkative?.uin ? person(state.currentTalkative) : null,
    list: list.map(person)
  }
}

async function honor (bot, gid, type) {
  const keys = type === 'all' ? Object.keys(HONORS) : [HONORS[type] ? type : 'talkative']
  const parts = []
  for (const key of keys) {
    const { current, list } = await honorOf(bot, gid, key)
    const lines = []
    if (current) lines.push(`当前龙王：${current.name}（${current.user_id}）${current.days ? `，已蝉联 ${current.days} 天` : ''}`)
    lines.push(...list.slice(0, 10).map((p, i) => `${i + 1}. ${p.name}（${p.user_id}）${p.desc ? ` ${p.desc}` : ''}`))
    if (list.length > 10) lines.push(`……共 ${list.length} 人`)
    parts.push(`【${HONORS[key].label}】\n${lines.join('\n') || '暂时没有人获得'}`)
  }
  return parts.join('\n')
}

async function level (bot, gid) {
  const cred = await web.credentials(bot, 'qqweb.qq.com')
  const ret = await web.call(`https://qqweb.qq.com/c/activedata/get_credit_level_info?bkn=${cred.bkn}&uin=${cred.uin}&gc=${gid}`, {
    cookie: cred.cookie,
    headers: { Referer: `https://qqweb.qq.com/m/business/qunlevel/index.html?gc=${gid}&from=0&_wv=1027` }
  })
  const lv = Number(ret.info?.uiGroupLevel)
  if (!Number.isFinite(lv) || lv <= 0) return '这个群暂时没有群星级（新群或不够活跃）'
  return `群星级：LV${lv} ${'⭐'.repeat(Math.min(lv, 10))}（共 5 级，越高越活跃）`
}

async function signIn (bot, gid, limit) {
  const cred = await web.credentials(bot, 'qun.qq.com')
  const dayYmd = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '')
  const ret = await web.call(`https://qun.qq.com/v2/signin/trpc/GetDaySignedList?g_tk=${cred.gtk}`, {
    cookie: cred.cookie,
    method: 'POST',
    headers: QNAME,
    body: { dayYmd, offset: 0, limit: 100, uid: cred.uin, groupId: String(gid) }
  })
  const page = ret.response?.page?.[0] || {}
  const list = page.infos || []
  if (!list.length) return '今天还没有人打卡'
  const lines = list.slice(0, limit).map((m, i) =>
    `${i + 1}. ${m.uidGroupNick || m.nick || ''}（${m.uid}）${m.signedTimeStamp ? ` ${chat.beijing(Number(m.signedTimeStamp) * 1000, { timeStyle: 'short' })}` : ''}`)
  return `今天已有 ${page.total || list.length} 人打卡：\n${lines.join('\n')}`
}

async function speakRank (bot, gid, weekly, limit) {
  const cred = await web.credentials(bot, 'qun.qq.com')
  const ret = await web.call(`${REPORT}/list?bkn=${cred.bkn}&gc=${gid}&type=0&start=0&time=${weekly ? 1 : 0}`, { cookie: cred.cookie, headers: QNAME })
  const list = ret.data?.speakRank || []
  if (!list.length) return `${weekly ? '近 7 天' : '昨天'}没有发言排行数据`
  const lines = list.slice(0, limit).map((m, i) => `${i + 1}. ${m.nickname}（${m.uin}）${m.msgCount} 条${m.active ? `，活跃 ${m.active} 天` : ''}`)
  return `${weekly ? '近 7 天' : '昨天'}发言排行：\n${lines.join('\n')}`
}

/** 群数据接口里可能出现的字段名 → 中文 */
const DATA_LABELS = Object.fromEntries([
  ['消息条数', ['msgCount', 'msg_count', 'msgNum', 'msgInfo']],
  ['发言人数', ['activeNum', 'active_num', 'activeMember', 'activeData']],
  ['入群人数', ['joinNum', 'join_num', 'joinData']],
  ['退群人数', ['exitNum', 'exit_num', 'exitData']],
  ['群成员数', ['memberNum', 'member_num', 'memberData']]
].flatMap(([label, keys]) => keys.map(k => [k, label])))

/** 群数据接口的字段不固定：认识的字段换成中文，数字和 { total } 都列出来，一个都没认出来时把原始数据交给 AI */
async function groupData (bot, gid, weekly) {
  const cred = await web.credentials(bot, 'qun.qq.com')
  const ret = await web.call(`${REPORT}/index?gc=${gid}&time=${weekly ? 1 : 0}&bkn=${cred.bkn}`, { cookie: cred.cookie, headers: QNAME })
  const data = ret.data || {}
  const lines = []
  for (const [k, v] of Object.entries(data)) {
    const value = typeof v === 'number' ? v : (v && typeof v === 'object' && !Array.isArray(v) ? v.total ?? v.num ?? v.count : undefined)
    if (typeof value === 'number' || /^\d+$/.test(String(value ?? ''))) lines.push(`${DATA_LABELS[k] || k}：${value}`)
  }
  const title = `${weekly ? '近 7 天' : '昨天'}的群数据`
  if (lines.length) return `${title}：\n${lines.join('\n')}`
  const raw = JSON.stringify(data)
  return raw && raw !== '{}' ? `${title}（原始数据）：${raw.slice(0, 1500)}` : `${title}：接口没有返回数据`
}

export class GroupActivityTool extends CustomTool {
  name = 'group_activity'

  function = {
    name: 'group_activity',
    description: 'QQ 群的活跃数据（需要同群的野生号）：群星级（level）、龙王和群荣誉，' +
      '包括群聊之火、群聊炽焰、冒尖小春笋、快乐源泉（honor）、今日群打卡名单（sign_in）、发言排行榜（speak_rank）、' +
      '消息数、入群退群人数等群数据（data）。用户问“谁是龙王”“谁话最多”“群几星”“今天谁打卡了”时调用。' +
      '群友只能查当前群，主人可以用 group_id 指定其他群。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['honor', 'level', 'sign_in', 'speak_rank', 'data'],
          description: 'honor=龙王/群荣誉（默认）；level=群星级；sign_in=今日打卡；speak_rank=发言排行；data=群数据统计'
        },
        type: {
          type: 'string',
          enum: [...Object.keys(HONORS), 'all'],
          description: 'action=honor 时的荣誉：talkative=龙王（默认）、performer=群聊之火、legend=群聊炽焰、strong_newbie=冒尖小春笋、emotion=快乐源泉、all=全部'
        },
        weekly: {
          type: 'boolean',
          description: 'speak_rank / data：true 为近 7 天，默认 false 为昨天'
        },
        group_id: {
          type: 'string',
          description: '群号，不填为当前群；查其他群仅主人可用'
        },
        limit: {
          type: 'number',
          description: '列表条数，默认 20，最多 100'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '拿不到当前消息'
    const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 20, 1), 100)
    try {
      const { gid } = grp.target(e, args.group_id)
      const bot = grp.requireWild(e, gid)
      switch (args.action) {
        case 'level': return await level(bot, gid)
        case 'sign_in': return await signIn(bot, gid, limit)
        case 'speak_rank': return await speakRank(bot, gid, args.weekly === true, limit)
        case 'data': return await groupData(bot, gid, args.weekly === true)
        default: return await honor(bot, gid, args.type || 'talkative')
      }
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new GroupActivityTool()
