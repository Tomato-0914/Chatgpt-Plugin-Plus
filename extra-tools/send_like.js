import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const chat = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_chat.js')).href)

export class SendLikeTool extends CustomTool {
  name = 'send_like'

  function = {
    name: 'send_like',
    description: '给某人的 QQ 资料卡点赞（不填 user_id 就给当前说话的人点）。用户说“给我点赞”“赞我”时调用。每人每天能收到的赞有上限，失败时如实告诉用户。',
    parameters: {
      type: 'object',
      properties: {
        user_id: {
          type: 'string',
          description: '要点赞的人的 QQ 号，不填为当前说话的人'
        },
        times: {
          type: 'number',
          description: '点赞次数，1-20，默认 10（非会员每天最多 10 次）'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '当前没有可用的聊天'
    const uid = chat.targetUser(e, args.user_id)
    const times = Math.min(Math.max(Math.floor(Number(args.times) || 10), 1), 20)
    try {
      const friend = (e.bot || globalThis.Bot)?.pickFriend?.(chat.asId(uid))
      if (typeof friend?.thumbUp !== 'function') return '当前机器人不支持点赞'
      const ret = await friend.thumbUp(times)
      // OneBot 返回 { status: 'failed', message / wording } 表示失败（如今天已经赞满）
      if (ret?.status === 'failed' || (ret?.retcode && ret.retcode !== 0)) {
        return `点赞失败：${ret.wording || ret.message || ret.msg || `错误码 ${ret.retcode}`}`
      }
      return `已给 ${uid} 点赞 ${times} 次`
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new SendLikeTool()
