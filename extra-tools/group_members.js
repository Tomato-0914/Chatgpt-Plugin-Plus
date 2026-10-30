import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)

const DAY = 24 * 3600
const MAX_DAYS = 3650
const ROLE_ORDER = { owner: 0, admin: 1 }
const byRole = (a, b) => (ROLE_ORDER[a.role] ?? 2) - (ROLE_ORDER[b.role] ?? 2)

/** 列表结果：标题 + 每行一人，超出 limit 时注明总数 */
function listText (title, list, limit, format = grp.line) {
  if (!list.length) return `${title}：没有`
  const lines = list.slice(0, limit).map((m, i) => `${i + 1}. ${format(m)}`)
  if (list.length > limit) lines.push(`……共 ${list.length} 人，只显示前 ${limit} 个`)
  return `${title}（${list.length} 人）：\n${lines.join('\n')}`
}

const days = (value, fallback, min) => {
  const n = Math.floor(Number(value ?? fallback))
  return Number.isFinite(n) && n >= min ? Math.min(n, MAX_DAYS) : fallback
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

async function check (e, group, uid) {
  if (grp.isQQ(uid)) {
    const list = await grp.requireMembers(group)
    const m = list.find(i => String(i.user_id) === String(uid))
    return m ? `${uid} 在群里：${grp.line(m)}${m.join_time ? `，${grp.time(m.join_time)} 入群` : ''}` : `${uid} 不在这个群里`
  }
  // 官方机器人的 openid：由 QQBot-Plugin 换成 QQ 号后交给野生号查资料
  const member = group?.pickMember?.(uid)
  if (typeof member?.getInfo !== 'function') return '当前机器人查不了这个用户，请提供 QQ 号'
  const info = await member.getInfo()
  return info && typeof info === 'object' && (info.nickname || info.card || info.role)
    ? `在群里：${grp.line({ user_id: info.user_id || uid, ...info })}`
    : '没有查到这个用户的群成员资料，可能不在这个群'
}

export class GroupMembersTool extends CustomTool {
  name = 'group_members'

  function = {
    name: 'group_members',
    description: '查询群成员名单：群主和管理员（admins）、成员列表（list）、某人在不在群里（check）、' +
      '多久没发言的潜水成员（inactive）、最近入群的新人（recent_join）、随机抽取群成员用于点名抽奖（random）。' +
      '群友只能查当前群，主人可以用 group_id 指定其他群。查某个人的详细资料用 member_info，按名字找人也用 member_info。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['admins', 'list', 'check', 'inactive', 'recent_join', 'random'],
          description: 'admins=群主和管理员（默认）；list=成员列表；check=是否在群里；inactive=潜水成员；recent_join=最近入群；random=随机抽取'
        },
        group_id: {
          type: 'string',
          description: '群号，不填为当前群；查其他群仅主人可用'
        },
        user_id: {
          type: 'string',
          description: 'action=check 时要检查的 QQ 号，不填为当前说话的人'
        },
        days: {
          type: 'number',
          description: 'inactive：多少天没发言算潜水，默认 30，填 0 为入群后从没发过言；recent_join：最近多少天入群，默认 7'
        },
        count: {
          type: 'number',
          description: 'action=random 时抽几个人，默认 1，最多 20'
        },
        exclude_admin: {
          type: 'boolean',
          description: 'action=random 时是否排除群主和管理员，默认 false'
        },
        limit: {
          type: 'number',
          description: '列表最多显示多少人，默认 30，最多 100'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '拿不到当前消息'
    const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 30, 1), 100)
    try {
      const { gid, current } = grp.target(e, args.group_id)
      const group = grp.groupOf(e, gid, current)
      if (args.action === 'check') return await check(e, group, chat.targetUser(e, args.user_id))

      const list = await grp.requireMembers(group)
      const now = Date.now() / 1000

      switch (args.action) {
        case 'list':
          return listText('群成员', [...list].sort(byRole), limit)

        case 'inactive': {
          if (!list.some(m => m.last_sent_time)) return '协议端没有提供群成员的最后发言时间，查不了潜水成员'
          const d = days(args.days, 30, 0)
          const found = list
            // 没发过言的人按入群时间算：刚入群几天的新人不算潜水
            .filter(m => (d === 0 ? grp.neverSpoke(m) : (grp.neverSpoke(m) ? Number(m.join_time) || 0 : Number(m.last_sent_time)) < now - d * DAY))
            .sort((a, b) => (grp.neverSpoke(a) ? 0 : Number(a.last_sent_time)) - (grp.neverSpoke(b) ? 0 : Number(b.last_sent_time)))
          return listText(d === 0 ? '入群后从没发过言的成员' : `${d} 天以上没发言的成员`, found, limit,
            m => `${grp.line(m)}，${grp.neverSpoke(m) ? '没发过言' : `最后发言 ${grp.time(m.last_sent_time)}`}${m.join_time ? `，${grp.time(m.join_time)} 入群` : ''}`)
        }

        case 'recent_join': {
          if (!list.some(m => m.join_time)) return '协议端没有提供群成员的入群时间，查不了最近入群的成员'
          const d = days(args.days, 7, 1)
          const found = list.filter(m => Number(m.join_time) >= now - d * DAY).sort((a, b) => Number(b.join_time) - Number(a.join_time))
          return listText(`最近 ${d} 天入群的成员`, found, limit,
            m => `${grp.line(m)}，${grp.time(m.join_time)} 入群${grp.neverSpoke(m) ? '，还没发过言' : ''}`)
        }

        case 'random': {
          const bots = grp.botIds(e)
          const pool = list.filter(m => !bots.has(String(m.user_id)) && !(args.exclude_admin && (m.role === 'owner' || m.role === 'admin')))
          if (!pool.length) return '没有符合条件的群成员可以抽'
          const n = Math.min(Math.max(Math.floor(Number(args.count)) || 1, 1), 20, pool.length)
          const picked = sample(pool, n)
          return `从 ${pool.length} 人里随机抽到 ${n} 人：\n${picked.map((m, i) => `${i + 1}. ${grp.line(m)}`).join('\n')}\n（要 @ 他们可以用 at_user 传这些 QQ 号）`
        }

        default: {
          const admins = list.filter(m => m.role === 'owner' || m.role === 'admin').sort(byRole)
          return listText('群主和管理员', admins, limit)
        }
      }
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new GroupMembersTool()
