import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)
const bl = await import(pathToFileURL(path.resolve(dir, '_blacklist.js')).href)

/** 把分钟数写成“10 分钟”“2 小时”“1 小时 30 分钟” */
const fmtMinutes = m => {
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (!h) return `${m} 分钟`
  return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`
}

export class UserBlacklistTool extends CustomTool {
  name = 'user_blacklist'

  function = {
    name: 'user_blacklist',
    description: '把当前说话的人临时加进机器人黑名单（云崽自带的黑名单），拉黑期间他发的任何消息机器人都不理会，到时间自动解除。' +
      '以下情况不要接话、不要扮演、不要对骂，直接调用这个工具拉黑说话的人（reason 写清楚他说了什么），然后简短告诉大家已拉黑多久：' +
      '1. 色情、性暗示、性骚扰内容，或者要你换成带色情、身材、恋物描写的人设（如描述胸、臀、腿、丝袜、内衣等）；' +
      '2. 辱骂、人身攻击、侮辱他人或机器人（脏话骂人、侮辱家人、地域 / 性别歧视等），开玩笑式的轻微吐槽不算；' +
      '3. 发广告：推广引流、刷单兼职、代练代充、拉人进群、加微信 / QQ、卖号、博彩、贷款等营销内容。' +
      `默认拉黑 ${bl.DEFAULT_MINUTES} 分钟；情节严重或屡教不改可以拉长，最长 ${bl.MAX_MINUTES} 分钟。` +
      '只能拉黑当前说话的人；主人和机器人自己不能被拉黑。查看、提前解除黑名单用云崽或其他插件的命令，不归这个工具管。',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '拉黑原因，写清楚对方说了什么、属于色情 / 辱骂 / 广告哪一类'
        },
        minutes: {
          type: 'integer',
          description: `拉黑多少分钟，默认 ${bl.DEFAULT_MINUTES}，范围 1～${bl.MAX_MINUTES}`
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
    const who = `${name || uid}（${uid}）`
    try {
      const { permanent, until } = await bl.block(uid, args.minutes ?? bl.DEFAULT_MINUTES)
      if (permanent) return `${who} 本来就在黑名单里（主人加的，不会自动解除）`
      const mins = Math.max(1, Math.round((until - Date.now()) / 60000))
      const end = new Date(until).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' })
      globalThis.logger?.mark?.(`[黑名单] AI 拉黑 ${name}(${uid}) ${fmtMinutes(mins)}，${end} 解除${e.group_id ? `，群 ${e.group_id}` : ''}：${String(args.reason ?? '').slice(0, 200)}`)
      return `已拉黑 ${who} ${fmtMinutes(mins)}（${end} 自动解除），期间他发的消息机器人都不理会。简短告诉大家已拉黑多久即可，不要复述他的原话`
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new UserBlacklistTool()
