import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const chat = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_chat.js')).href)

/** 群名片或昵称：官方机器人 @ 不到人时写名字用（官方机器人查群成员由 QQBot-Plugin 交给野生号） */
async function nameOf (e, id) {
  try {
    const info = await e.group?.pickMember?.(chat.asId(id))?.getInfo?.()
    return info?.card || info?.nickname || ''
  } catch {
    return ''
  }
}

export class AtUserTool extends CustomTool {
  name = 'at_user'

  function = {
    name: 'at_user',
    description: '在群里 @ 一个或几个人并附上一句话，被 @ 的人会收到提醒。用户让你“叫一下某某”“提醒某某”时调用；只知道名字时先用 member_info 搜索 QQ 号。',
    parameters: {
      type: 'object',
      properties: {
        user_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '要 @ 的人的 QQ 号，最多 5 个'
        },
        text: {
          type: 'string',
          description: '@ 之后跟的话'
        }
      },
      required: ['user_ids']
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e?.isGroup && !e?.group_id) return '只能在群里 @ 人'
    const ids = [...new Set((Array.isArray(args.user_ids) ? args.user_ids : [args.user_ids])
      .map(id => String(id ?? '').replace(/^@/, '').trim()).filter(Boolean))]
    if (!ids.length) return '请提供要 @ 的 QQ 号'
    if (ids.length > 5) return '一次最多 @ 5 个人'
    if (ids.some(id => id === 'all')) return '不能 @ 全体成员'
    const msg = []
    const unbound = []
    const text = String(args.text || '').trim()
    try {
      for (const id of ids) {
        const { seg, real } = await chat.mention(e, id, await nameOf(e, id))
        msg.push(seg)
        if (real) msg.push(' ')
        else unbound.push(id)
      }
      if (text) msg.push(text)
      const ret = await e.reply(msg)
      if (!chat.sent(ret)) return `发送失败：${chat.failReason(ret)}`
      return `已经 @ 了 ${ids.join('、')}${text ? '并说了这句话' : ''}` +
        `${unbound.length ? `（其中 ${unbound.join('、')} 没有绑定 QQ 号，官方机器人 @ 不到，只写了名字，对方收不到提醒）` : ''}，不需要再重复`
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new AtUserTool()
