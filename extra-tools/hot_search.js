import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const sixty = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_sixty.js')).href)

const SOURCES = {
  weibo: { label: '微博', load: async () => (await sixty.fetch60s('/weibo')).map(i => ({ title: i.title, hot: i.hot_value })) },
  baidu: { label: '百度', load: async () => (await sixty.fetch60s('/baidu/hot')).map(i => ({ title: i.title, hot: i.score })) },
  douyin: { label: '抖音', load: async () => (await sixty.fetch60s('/douyin')).map(i => ({ title: i.title, hot: i.hot_value })) },
  toutiao: { label: '今日头条', load: async () => (await sixty.fetch60s('/toutiao')).map(i => ({ title: i.title, hot: i.hot_value })) },
  zhihu: { label: '知乎', load: async () => (await sixty.fetch60s('/zhihu')).map(i => ({ title: i.title, hot: i.hot_value })) },
  bilibili: {
    label: 'B站',
    // 60s 的 B 站接口不稳定，直接用 B 站搜索热词
    load: async () => {
      const res = await fetch('https://s.search.bilibili.com/main/hotword', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(10000)
      })
      const data = await res.json()
      if (data.code !== 0) throw new Error(data.message || `接口返回错误（${data.code}）`)
      return (data.list || []).map(i => ({ title: i.show_name || i.keyword, hot: 0 }))
    }
  }
}

export class HotSearchTool extends CustomTool {
  name = 'hot_search'

  function = {
    name: 'hot_search',
    description: '获取热搜榜（微博、百度、抖音、今日头条、知乎、B站）。用户问热搜、热点、最近大家在聊什么时调用；想了解某条热搜的详情再用 web_search。',
    parameters: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: Object.keys(SOURCES),
          description: '平台，默认 weibo'
        },
        limit: {
          type: 'number',
          description: '返回条数，默认 10，最多 30'
        }
      },
      required: []
    }
  }

  async run (args) {
    const platform = SOURCES[args.platform] ? args.platform : 'weibo'
    const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 10), 1), 30)
    try {
      const items = (await SOURCES[platform].load()).filter(i => i.title).slice(0, limit)
      if (!items.length) return `${SOURCES[platform].label}热搜暂时为空`
      const lines = items.map((i, n) => `${n + 1}. ${i.title}${sixty.formatHot(i.hot) ? `（${sixty.formatHot(i.hot)}）` : ''}`)
      return `${SOURCES[platform].label}热搜：\n${lines.join('\n')}`
    } catch (err) {
      return `获取${SOURCES[platform].label}热搜失败：${sixty.errorText(err)}`
    }
  }
}

export default new HotSearchTool()
