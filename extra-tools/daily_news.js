import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const sixty = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_sixty.js')).href)

export class DailyNewsTool extends CustomTool {
  name = 'daily_news'

  function = {
    name: 'daily_news',
    description: '获取每日资讯：news=每天 60 秒读懂世界（当日新闻早报），history=历史上的今天。用户问今天有什么新闻、早报、历史上的今天时调用。',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['news', 'history'],
          description: 'news=60 秒新闻早报（默认），history=历史上的今天'
        }
      },
      required: []
    }
  }

  async run (args) {
    try {
      if (args.type === 'history') {
        const data = await sixty.fetch60s('/today-in-history')
        const items = (data.items || []).slice(0, 12)
        if (!items.length) return '暂时没有历史上的今天的数据'
        return [`历史上的今天（${data.month}月${data.day}日）：`, ...items.map(i => `${i.year}年：${i.title}`)].join('\n')
      }
      const data = await sixty.fetch60s('/60s')
      const title = `60 秒读懂世界（${[data.date, data.day_of_week, data.lunar_date].filter(Boolean).join(' ')}）`
      const lines = [title, ...(data.news || []).map((item, i) => `${i + 1}. ${item}`)]
      if (data.tip) lines.push(`微语：${data.tip}`)
      return lines.join('\n')
    } catch (err) {
      return `获取失败：${sixty.errorText(err)}`
    }
  }
}

export default new DailyNewsTool()
