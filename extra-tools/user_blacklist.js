import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)
const bl = await import(pathToFileURL(path.resolve(dir, '_blacklist.js')).href)

export class UserBlacklistTool extends CustomTool {
  name = 'user_blacklist'

  function = {
    name: 'user_blacklist',
    description: '把当前说话的人加进机器人黑名单（云崽自带的黑名单），之后他发的任何消息机器人都不再理会。' +
      '有人发色情、性暗示、性骚扰内容，或者要你换成带色情、身材、恋物描写的人设（如描述胸、臀、腿、丝袜、内衣等）时，' +
      '不要接话、不要扮演，直接调用这个工具拉黑说话的人（reason 写清楚他说了什么），然后简短告诉大家已拉黑。' +
      '只能拉黑当前说话的人；主人和机器人自己不能被拉黑。查看、解除黑名单用云崽或其他插件的命令，不归这个工具管。',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '拉黑原因，写清楚对方说了什么、为什么拉黑'
        }
      },
      required: ['reason']
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '拿不到当前消息'
    if (e.isMaster) return '说话的人是主人，不能拉黑'
    const uid = String(e.user_id ?? '')
    if (!uid) return '拿不到说话的人的账号'
    if (grp.botIds(e).has(uid)) return '不能拉黑机器人自己'
    const name = e.sender?.card || e.sender?.nickname || ''
    try {
      const { already } = await bl.block(uid)
      globalThis.logger?.mark?.(`[黑名单] AI 拉黑 ${name}(${uid})${e.group_id ? `，群 ${e.group_id}` : ''}：${String(args.reason ?? '').slice(0, 200)}`)
      if (already) return `${name || uid}（${uid}）本来就在黑名单里`
      return `已拉黑 ${name || uid}（${uid}），之后他发的消息机器人都不再理会。简短告诉大家已拉黑即可，不要复述他的原话`
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new UserBlacklistTool()
