import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const chat = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_chat.js')).href)

const ROLE = { owner: '群主', admin: '管理员', member: '群员' }
const SEX = { male: '男', female: '女' }

function formatInfo (uid, info) {
  const time = t => (t ? chat.beijing(Number(t) * 1000, { dateStyle: 'medium', timeStyle: 'short' }) : '')
  const lines = [
    ['QQ', info.user_id || uid],
    ['群名片', info.card],
    ['昵称', info.nickname],
    ['身份', ROLE[info.role] || info.role],
    ['头衔', info.title],
    ['群等级', info.level],
    ['性别', SEX[info.sex]],
    ['年龄', info.age || ''],
    ['地区', info.area],
    ['入群时间', time(info.join_time)],
    ['最后发言', time(info.last_sent_time)]
  ].filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== 0)
  return lines.map(([k, v]) => `${k}：${v}`).join('\n')
}

/** 群成员列表：优先 getMemberMap（官方机器人由野生号补全），没有时用 getMemberList */
async function members (group) {
  if (typeof group?.getMemberMap === 'function') {
    const map = await group.getMemberMap()
    return [...map.entries()].map(([id, info]) => ({ user_id: id, ...info }))
  }
  if (typeof group?.getMemberList === 'function') {
    const list = await group.getMemberList()
    return Array.isArray(list) ? list.map(i => (typeof i === 'object' ? i : { user_id: i })) : []
  }
  return []
}

export class MemberInfoTool extends CustomTool {
  name = 'member_info'

  function = {
    name: 'member_info',
    description: '查询群成员资料（群名片、昵称、身份、头衔、等级、入群时间、最后发言等），或按名字搜索群成员拿到 QQ 号。' +
      '需要 @ 某人、给某人点赞但只知道名字时，先用 search 找到 QQ 号。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'search'],
          description: 'get=查询某人资料（默认）；search=按群名片/昵称搜索成员'
        },
        user_id: {
          type: 'string',
          description: 'action=get 时的 QQ 号，不填为当前说话的人'
        },
        keyword: {
          type: 'string',
          description: 'action=search 时的名字关键词'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e?.isGroup && !e?.group_id) return '只能在群里查询群成员'
    try {
      if (args.action === 'search') {
        const keyword = String(args.keyword || '').trim().toLowerCase()
        if (!keyword) return '请提供要搜索的名字'
        const found = (await members(e.group)).filter(m =>
          [m.card, m.nickname, m.user_id].some(v => String(v ?? '').toLowerCase().includes(keyword)))
        if (!found.length) return `群里没有找到名字包含“${args.keyword}”的成员`
        const lines = found.slice(0, 15).map(m =>
          `${m.card || m.nickname || '（无名）'}${m.card && m.nickname && m.card !== m.nickname ? `（${m.nickname}）` : ''} QQ:${m.user_id}${m.role && m.role !== 'member' ? ` ${ROLE[m.role] || m.role}` : ''}`)
        if (found.length > 15) lines.push(`……共 ${found.length} 人，请用更具体的名字搜索`)
        return `找到 ${found.length} 个成员：\n${lines.join('\n')}`
      }

      const uid = chat.targetUser(e, args.user_id)
      const member = e.group?.pickMember?.(chat.asId(uid))
      if (typeof member?.getInfo !== 'function') return '当前机器人不支持查询群成员资料'
      const info = await member.getInfo()
      if (!info || typeof info !== 'object') return `没有查到 ${uid} 的群成员资料（可能不在这个群）`
      return formatInfo(uid, info)
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new MemberInfoTool()
