import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)
const web = await import(pathToFileURL(path.resolve(dir, '_qqweb.js')).href)

const DAY = 24 * 3600

async function info (e, gid, current) {
  const data = await grp.groupInfo(e, gid, current)
  const list = await grp.members(grp.groupOf(e, gid, current)).catch(() => [])
  const owner = list.find(m => m.role === 'owner') || (data.owner_id && { user_id: data.owner_id })
  const admins = list.filter(m => m.role === 'admin')
  const wild = grp.wildFor(e, gid)
  const self = wild && list.find(m => String(m.user_id) === String(wild.uin))
  const count = data.member_count || list.length
  const lines = [
    ['群名', data.group_name || data.name],
    ['群号', grp.isQQ(gid) ? gid : ''],
    ['人数', count ? `${count}${data.max_member_count ? ` / ${data.max_member_count}` : ''}` : ''],
    ['群主', owner ? grp.line(owner).replace(/ 群主$/, '') : ''],
    ['管理员', list.length ? `${admins.length} 人${admins.length ? `：${admins.slice(0, 10).map(grp.nameOf).join('、')}${admins.length > 10 ? ' 等' : ''}` : ''}` : ''],
    ['建群时间', grp.time(data.create_time)],
    ['群等级', data.group_level || data.grade],
    [wild === e.bot ? '机器人身份' : '同群野生号身份', self ? grp.ROLE[self.role] || self.role : ''],
    ['全员禁言', data.shutup_time_whole ? '开启' : '']
  ].filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== 0)
  if (!lines.length) return '没有查到这个群的资料'
  return lines.map(([k, v]) => `${k}：${v}`).join('\n')
}

function groupList (e, keyword, limit) {
  if (!e?.isMaster) return '只有主人可以查看机器人加入的群列表'
  const gl = e.bot?.gl
  if (!gl?.size) return '当前机器人没有群列表缓存'
  const kw = String(keyword ?? '').trim().toLowerCase()
  const all = [...gl.entries()].map(([id, g]) => ({ group_id: g?.group_id ?? id, group_name: g?.group_name || g?.name || '', member_count: g?.member_count }))
  const found = kw ? all.filter(g => [g.group_name, g.group_id].some(v => String(v ?? '').toLowerCase().includes(kw))) : all
  if (!found.length) return `没有找到名字或群号包含“${keyword}”的群`
  const lines = found.slice(0, limit).map((g, i) => `${i + 1}. ${g.group_name || '（未知群名）'}（${g.group_id}）${g.member_count ? ` ${g.member_count} 人` : ''}`)
  if (found.length > limit) lines.push(`……共 ${found.length} 个群`)
  return `${kw ? `找到 ${found.length} 个群` : `机器人加入了 ${all.length} 个群`}：\n${lines.join('\n')}`
}

/** 公告：网页接口（feeds 为普通公告，inst 为置顶公告） */
async function notices (e, gid, index, limit) {
  const bot = grp.requireWild(e, gid)
  const cred = await web.credentials(bot, 'qun.qq.com')
  const ret = await web.call(`https://web.qun.qq.com/cgi-bin/announce/get_t_list?bkn=${cred.bkn}&qid=${gid}&ft=23&s=-1&n=20&ni=1&i=1`, cred)
  const seen = new Set()
  const list = []
  for (const [items, top] of [[ret.inst, true], [ret.feeds, false]]) {
    for (const n of Array.isArray(items) ? items : []) {
      if (seen.has(n.fid)) continue
      seen.add(n.fid)
      list.push({
        top,
        title: web.unescape(n.msg?.title),
        text: web.unescape(n.msg?.text).trim(),
        sender: n.u,
        time: n.pubt,
        read: n.read_num,
        confirm: n.settings?.confirm_required === 1
      })
    }
  }
  if (!list.length) return '这个群没有群公告'
  const head = n => `${n.top ? '【置顶】' : ''}${n.title ? `${n.title} ` : ''}${grp.time(n.time)} 由 ${n.sender} 发布${n.read ? `，${n.read} 人已读` : ''}${n.confirm ? '，需确认' : ''}`
  if (index) {
    const n = list[index - 1]
    if (!n) return `没有第 ${index} 条公告，共 ${list.length} 条`
    return `第 ${index} 条公告：${head(n)}\n${n.text || '（无文字）'}`
  }
  const preview = text => {
    const flat = text.replace(/\s+/g, ' ')
    return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat || '（无文字）'
  }
  const lines = list.slice(0, limit).map((n, i) => `${i + 1}. ${head(n)}\n   ${preview(n.text)}`)
  return `共 ${list.length} 条群公告${list.length > limit ? `，显示前 ${limit} 条` : ''}（要看全文用 index 指定序号）：\n${lines.join('\n')}`
}

async function stat (e, gid, current) {
  const list = await grp.requireMembers(grp.groupOf(e, gid, current))
  const now = Date.now() / 1000
  const count = fn => list.filter(fn).length
  const lastSent = m => Number(m.last_sent_time) || 0
  const spoke = m => !grp.neverSpoke(m)
  const lines = [
    `成员总数：${list.length}`,
    `身份：群主 ${count(m => m.role === 'owner')}，管理员 ${count(m => m.role === 'admin')}，群员 ${count(m => m.role !== 'owner' && m.role !== 'admin')}`,
    `性别：男 ${count(m => m.sex === 'male')}，女 ${count(m => m.sex === 'female')}，未知 ${count(m => m.sex !== 'male' && m.sex !== 'female')}`
  ]
  if (list.some(m => m.join_time)) {
    lines.push(`入群：近 7 天 ${count(m => Number(m.join_time) >= now - 7 * DAY)} 人，近 30 天 ${count(m => Number(m.join_time) >= now - 30 * DAY)} 人`)
  }
  if (list.some(m => m.last_sent_time)) {
    lines.push(`发言：近 7 天发过言 ${count(m => lastSent(m) >= now - 7 * DAY)} 人，近 30 天 ${count(m => lastSent(m) >= now - 30 * DAY)} 人，` +
      `30 天以上没发言 ${count(m => spoke(m) && lastSent(m) < now - 30 * DAY)} 人，入群后没发过言 ${count(m => !spoke(m))} 人`)
  }
  return lines.join('\n')
}

export class GroupInfoTool extends CustomTool {
  name = 'group_info'

  function = {
    name: 'group_info',
    description: '查询群的资料：群名、群号、人数、群主、管理员（info）；机器人加入的群列表，可按群名/群号搜索（list，仅主人）；' +
      '群公告（notice）；成员统计，身份、性别、入群、发言活跃情况（stat）。' +
      '群友只能查当前群，主人可以用 group_id 指定其他群。查单个成员用 member_info，成员名单用 group_members。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['info', 'list', 'notice', 'stat'],
          description: 'info=群资料（默认）；list=机器人加入的群列表/搜索群（仅主人）；notice=群公告；stat=成员统计'
        },
        group_id: {
          type: 'string',
          description: '群号，不填为当前群；查其他群仅主人可用'
        },
        keyword: {
          type: 'string',
          description: 'action=list 时按群名或群号搜索'
        },
        index: {
          type: 'number',
          description: 'action=notice 时查看第几条公告的全文，不填为公告列表'
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
      if (args.action === 'list') return groupList(e, args.keyword, limit)
      const { gid, current } = grp.target(e, args.group_id)
      if (args.action === 'notice') return await notices(e, gid, Math.floor(Number(args.index)) || 0, Math.min(limit, 20))
      if (args.action === 'stat') return await stat(e, gid, current)
      return await info(e, gid, current)
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new GroupInfoTool()
