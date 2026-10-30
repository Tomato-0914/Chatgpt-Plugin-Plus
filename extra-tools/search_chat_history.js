import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const chat = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_chat.js')).href)

export class SearchChatHistoryTool extends CustomTool {
  name = 'search_chat_history'

  function = {
    name: 'search_chat_history',
    description: '翻看本群较早的聊天记录：按关键词、发送者筛选，或不带条件查看最近的消息。' +
      '用户问“刚才/昨天谁说了什么”“某某之前提到过什么”“大家刚才在聊什么”时调用。',
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '消息里包含的关键词，可不填'
        },
        user_id: {
          type: 'string',
          description: '只看这个人发的消息（QQ 号），可不填'
        },
        scan: {
          type: 'number',
          description: '往前翻多少条消息，默认 200，最多 1000'
        },
        limit: {
          type: 'number',
          description: '最多返回几条结果，默认 20，最多 50'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e?.isGroup && !e?.group_id) return '只能在群里查询聊天记录'
    const groupId = String(e.group_id)
    if (!/^\d{5,12}$/.test(groupId)) return '这个群还没有群绑定（不知道真实群号），无法读取聊天记录'
    const bot = chat.isWildBot(e.bot) ? e.bot : chat.wildInGroup(groupId)
    if (!bot) return '这个群里没有在线的野生号，无法读取聊天记录'

    const keyword = String(args.keyword || '').trim().toLowerCase()
    const userId = String(args.user_id || '').replace(/^@/, '').trim()
    const scan = Math.min(Math.max(Math.floor(Number(args.scan) || 200), 20), 1000)
    const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 20), 1), 50)
    try {
      const history = await chat.fetchHistory(bot, groupId, scan)
      if (!history.length) return '没有读取到聊天记录'
      const matched = history
        .map(msg => ({ msg, text: chat.textOf(msg) }))
        .filter(({ msg, text }) =>
          text &&
          (!userId || String(msg.user_id ?? msg.sender?.user_id) === userId) &&
          (!keyword || text.toLowerCase().includes(keyword)))
      const from = chat.beijing(Number(history[0].time) * 1000, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      const scope = `（翻看了最近 ${history.length} 条，最早到 ${from}）`
      if (!matched.length) return `没有找到符合条件的消息${scope}`
      const lines = matched.slice(-limit).map(({ msg, text }) => {
        const when = chat.beijing(Number(msg.time) * 1000, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        const sender = msg.sender || {}
        const name = sender.card || sender.nickname || ''
        return `[${when}] ${name}(${msg.user_id ?? sender.user_id})：${text.length > 120 ? `${text.slice(0, 120)}…` : text}`
      })
      return `找到 ${matched.length} 条${matched.length > limit ? `，下面是最近的 ${limit} 条` : ''}${scope}：\n${lines.join('\n')}`
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

export default new SearchChatHistoryTool()
