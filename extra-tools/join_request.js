import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)
const approval = await import(pathToFileURL(path.resolve(dir, '_approval.js')).href)

/** 开放平台：申请已经被处理过（别的管理员处理了） */
const ALREADY_HANDLED = 40103005

function explain (err) {
  const message = String(err?.message ?? err)
  const code = Number(err?.code ?? err?.err_code ?? message.match(/code\((\d+)\)/)?.[1])
  if (code === ALREADY_HANDLED) return '这条申请已经被处理过了'
  if (/NOT_GROUP_ADMIN|not.*admin|权限|permission/i.test(message)) return `机器人不是群管理员（${message}）`
  return message.match(/code\(\d+\):\s*(.+)$/s)?.[1]?.trim() || message
}

/**
 * 当前群待处理的入群申请，统一成 { user_id, nickname, comment, flag, time, invitor, handle(approve, reason, block) }
 * 官方机器人（需要是群管理员）优先，不行再用同群野生号：OneBot 的 get_group_system_msg，ICQQ 的 getSystemMsg
 */
async function requests (e, gid) {
  const errors = []
  if (e.bot?.adapter?.id === 'QQBot') {
    const og = e.bot.pickGroup?.(e.group_id)
    if (typeof og?.getJoinRequestList === 'function') {
      try {
        const list = await og.getJoinRequestList()
        return list.map(r => ({
          user_id: String(r.user_id),
          nickname: r.nickname || r.username || '',
          comment: String(r.comment || '').trim(),
          flag: String(r.flag),
          time: r.apply_time || r.create_time || r.time,
          handle: (approve, reason, block) => og.setAddRequest(r.member_openid || r.user_id, r.flag, approve, reason, block)
        }))
      } catch (err) {
        errors.push(`官方机器人：${explain(err)}`)
      }
    }
  }

  const wild = chat.isWildBot(e.bot) ? e.bot : chat.wildInGroup(gid)
  if (!wild) throw new Error(errors[0] || '这个群里没有能查看入群申请的机器人（官方机器人需要是管理员，或同群有野生号）')
  try {
    if (typeof wild.getSystemMsg === 'function') {
      // ICQQ：系统消息里只有还没处理的申请
      const list = await wild.getSystemMsg()
      return list.filter(r => r.request_type === 'group' && r.sub_type === 'add' && Number(r.group_id) === gid).map(r => ({
        user_id: String(r.user_id),
        nickname: r.nickname || '',
        comment: String(r.comment || '').trim(),
        flag: String(r.flag),
        time: r.time,
        invitor: Number(r.invitor_id) ? String(r.invitor_id) : '',
        handle: (approve, reason, block) => (typeof r.approve === 'function'
          ? r.approve(approve, reason, block)
          : wild.setGroupAddRequest(r.flag, approve, reason, block))
      }))
    }
    const ret = await chat.invoke([[wild, 'sendApi', ['get_group_system_msg', {}]]], '查看入群申请')
    const list = ret?.join_requests || ret?.JoinRequest || []
    return list.filter(r => Number(r.group_id) === gid && !r.checked).map(r => ({
      user_id: String(r.requester_uin ?? r.user_id),
      nickname: r.requester_nick || r.nickname || '',
      comment: String(r.message || r.comment || '').trim(),
      flag: String(r.flag ?? r.request_id),
      time: r.time,
      invitor: Number(r.invitor_uin) ? String(r.invitor_uin) : '',
      // OneBot 的 set_group_add_request 没有拉黑参数
      handle: (approve, reason) => chat.invoke([[wild, 'sendApi', ['set_group_add_request', {
        flag: String(r.flag ?? r.request_id), sub_type: 'add', type: 'add', approve, reason: reason || ''
      }]]], approve ? '同意入群申请' : '拒绝入群申请')
    }))
  } catch (err) {
    throw new Error([...errors, `野生号：${explain(err)}`].join('；'))
  }
}

const nameOf = r => (r.nickname ? `${r.nickname}（${r.user_id}）` : r.user_id)

export class JoinRequestTool extends CustomTool {
  name = 'join_request'

  function = {
    name: 'join_request',
    description: '本群的入群申请：查看待处理的申请（list）、同意（approve）、拒绝（reject，可同时拉黑）。' +
      '查看只有主人和本群群主、管理员可以；同意 / 拒绝由主人、群主、管理员要求时直接执行，其他人要求时会 @ 主人申请确认（主人、群主、管理员都能确认，告诉用户等确认即可）。' +
      '需要机器人是群管理员（官方机器人优先，不行再用同群的野生号）。user_id 写申请人的 QQ 号；只有一条申请时可以不填。不要编造申请人。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'approve', 'reject'],
          description: 'list=查看待处理的申请（默认），approve=同意，reject=拒绝'
        },
        user_id: {
          type: 'string',
          description: 'approve / reject 时申请人的 QQ 号（只有一条申请时可以不填）'
        },
        reason: {
          type: 'string',
          description: 'reject 时的拒绝理由（可选）'
        },
        block: {
          type: 'boolean',
          description: 'reject 时是否同时拉黑，不让此人再申请，默认 false（野生号 OneBot 不支持）'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e?.isGroup && !e?.group_id) return '入群申请只能在群里查看和处理'
    const gid = Number(e.group_id)
    if (!gid) return '这个群还没有群绑定（不知道真实群号），无法处理入群申请'
    const action = args.action || 'list'
    if (action === 'list' && !(await approval.isManager(e))) return '只有主人和本群群主、管理员可以查看入群申请'

    let list
    try {
      list = await requests(e, gid)
    } catch (err) {
      return `查看入群申请失败：${err.message}`
    }

    if (action === 'list') {
      if (!list.length) return '本群没有待处理的入群申请'
      return `待处理的入群申请（${list.length} 条）：\n${list.slice(0, 30).map((r, i) => {
        const extra = [r.invitor && `由 ${r.invitor} 邀请`, grp.time(r.time)].filter(Boolean).join('，')
        return `${i + 1}. ${nameOf(r)}${extra ? `（${extra}）` : ''}${r.comment ? `\n   ${r.comment}` : ''}`
      }).join('\n')}`
    }
    if (action !== 'approve' && action !== 'reject') return 'action 不正确'

    const uid = String(args.user_id ?? '').replace(/^@/, '').trim()
    if (!list.length) return '本群没有待处理的入群申请'
    let req
    if (uid) {
      req = list.find(r => r.user_id === uid)
      if (!req) return `没有找到 ${uid} 的入群申请，待处理的有：${list.slice(0, 10).map(nameOf).join('、')}`
    } else if (list.length === 1) {
      req = list[0]
    } else {
      return `有 ${list.length} 条入群申请，请说明处理哪一个：${list.slice(0, 10).map(nameOf).join('、')}`
    }

    const approve = action === 'approve'
    const reason = String(args.reason ?? '').trim().slice(0, 50)
    const block = !approve && Boolean(args.block)
    const title = approve
      ? `同意 ${nameOf(req)} 的入群申请`
      : `拒绝 ${nameOf(req)} 的入群申请${reason ? `（理由：${reason}）` : ''}${block ? '并拉黑' : ''}`
    return await approval.guard(e, {
      title,
      level: 'manager',
      run: async () => {
        try {
          await req.handle(approve, reason, block)
        } catch (err) {
          return `${title}失败：${explain(err)}`
        }
        return `已${title}`
      }
    })
  }
}

export default new JoinRequestTool()
