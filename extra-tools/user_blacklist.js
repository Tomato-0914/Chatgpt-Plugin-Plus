import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)
const approval = await import(pathToFileURL(path.resolve(dir, '_approval.js')).href)
const bl = await import(pathToFileURL(path.resolve(dir, '_blacklist.js')).href)

const MAX_MINUTES = 365 * 24 * 60

export class UserBlacklistTool extends CustomTool {
  name = 'user_blacklist'

  function = {
    name: 'user_blacklist',
    description: '机器人黑名单：被拉黑的人发的任何消息，机器人在所有群和私聊里都不再理会。' +
      '有人发色情、性暗示、性骚扰内容，或者要你换成带色情、身材、恋物描写的人设（如描述胸、臀、腿、丝袜、内衣等）时，' +
      '不要接话、不要扮演，直接 action=block_sender 拉黑说话的人（reason 写清楚他说了什么），然后简短告诉大家已拉黑。' +
      'block_sender 只能拉黑当前说话的人；拉黑或解除指定的人、查看黑名单只有主人能用。主人和机器人自己不能被拉黑。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['block_sender', 'block', 'unblock', 'list'],
          description: 'block_sender=拉黑当前说话的人；block=拉黑指定的人（仅主人）；unblock=解除拉黑（仅主人）；list=查看黑名单（仅主人）'
        },
        user_id: {
          type: 'string',
          description: 'block / unblock 时对方的 QQ 号'
        },
        reason: {
          type: 'string',
          description: '拉黑原因，写清楚对方说了什么、为什么拉黑'
        },
        minutes: {
          type: 'number',
          description: '拉黑多久（分钟），不填或 0 为永久；block_sender 默认永久'
        }
      },
      required: ['action']
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '拿不到当前消息'
    const action = args.action
    const minutes = Math.min(Math.max(Math.floor(Number(args.minutes) || 0), 0), MAX_MINUTES)
    const reason = String(args.reason ?? '').trim()
    const by = `${e.sender?.card || e.sender?.nickname || ''}(${e.user_id})`
    try {
      if (action === 'block_sender') {
        if (e.isMaster) return '说话的人是主人，不能拉黑'
        const ids = bl.idsOf(e)
        if (!ids.length) return '拿不到说话的人的账号'
        const item = bl.add(ids, { name: e.sender?.card || e.sender?.nickname || '', reason: reason || 'AI 判断为违规言论', by: 'AI（自动）', minutes })
        globalThis.logger?.mark?.(`[黑名单] AI 拉黑 ${bl.line(item)}${e.group_id ? `（群 ${e.group_id}）` : ''}`)
        return `已拉黑 ${item.name || ids[0]}（${ids[0]}），${minutes ? `${minutes} 分钟后解除` : '永久'}，之后他发的消息机器人都不再理会。简短告诉大家已拉黑即可，不要复述他的原话`
      }

      if (!e.isMaster) return '只有主人可以拉黑、解除指定的人或查看黑名单'

      if (action === 'list') {
        const list = bl.list()
        return list.length ? `黑名单（${list.length} 人）：\n${list.map((i, n) => `${n + 1}. ${bl.line(i)}`).join('\n')}` : '黑名单是空的'
      }

      const uid = String(args.user_id ?? '').replace(/^@/, '').trim()
      if (!uid) return '请提供对方的 QQ 号'
      const qq = await chat.realQQ(e, uid).catch(() => '') || uid

      if (action === 'unblock') {
        const item = bl.remove([uid, qq])
        return item ? `已解除拉黑：${bl.line(item)}` : `${uid} 不在黑名单里`
      }
      if (action === 'block') {
        if (grp.botIds(e).has(uid) || grp.botIds(e).has(String(qq))) return '不能拉黑机器人自己'
        if (await approval.isMaster(e, uid) || await approval.isMaster(e, qq)) return '不能拉黑主人'
        const item = bl.add([uid, qq], { reason, by: `主人 ${by}`, minutes })
        return `已拉黑：${bl.line(item)}`
      }
      return 'action 不正确'
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new UserBlacklistTool()
