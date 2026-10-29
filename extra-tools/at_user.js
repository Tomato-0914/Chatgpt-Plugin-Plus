import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const chat = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_chat.js')).href)

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
    for (const id of ids) msg.push({ type: 'at', qq: chat.asId(id) }, ' ')
    const text = String(args.text || '').trim()
    if (text) msg.push(text)
    try {
      const ret = await e.reply(msg)
      if (!chat.sent(ret)) return `发送失败：${chat.failReason(ret)}`
      return `已经 @ 了 ${ids.join('、')}${text ? '并说了这句话' : ''}，不需要再重复`
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new AtUserTool()
