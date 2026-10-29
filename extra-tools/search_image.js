import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const images = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_images.js')).href)

/** 搜索时附加在关键词后面的词，让结果更贴近想要的类型 */
const KIND = { emoji: '表情包', wallpaper: '壁纸', any: '' }

export class SearchImageTool extends CustomTool {
  name = 'search_image'

  function = {
    name: 'search_image',
    description: '按关键词搜图片并直接发到聊天里（从结果里随机挑选）：kind=emoji 搜表情包（斗图、用表情包回应），' +
      'kind=wallpaper 搜壁纸 / 头像素材，kind=any 搜普通图片（某个角色、风景、东西长什么样）。',
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '关键词，如“猫猫 震惊”“原神 刻晴”“星空”'
        },
        kind: {
          type: 'string',
          enum: ['emoji', 'wallpaper', 'any'],
          description: 'emoji=表情包（默认），wallpaper=壁纸，any=普通图片'
        },
        count: {
          type: 'number',
          description: '发几张，1-3，默认 1'
        }
      },
      required: ['keyword']
    }
  }

  async run (args, context) {
    const keyword = String(args.keyword || '').trim()
    if (!keyword) return '请提供关键词'
    const kind = KIND[args.kind] !== undefined ? args.kind : 'emoji'
    const count = Math.min(Math.max(Math.floor(Number(args.count) || 1), 1), 3)
    const query = [keyword, KIND[kind]].filter(Boolean).join(' ')
    try {
      const res = await fetch(`https://www.duitang.com/napi/blog/list/by_search/?kw=${encodeURIComponent(query)}&start=0&limit=48`, {
        headers: {
          accept: 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
          'x-requested-with': 'XMLHttpRequest'
        },
        signal: AbortSignal.timeout(10000)
      })
      const data = await res.json()
      const urls = (data?.data?.object_list || []).map(item => item.photo?.path).filter(Boolean)
      if (!urls.length) return `没有找到“${query}”的图片，换个关键词试试`
      return images.sendImages(context?.getEvent?.(), images.pick(urls, count))
    } catch (err) {
      return `搜索图片失败：${err.name === 'TimeoutError' ? '请求超时' : err.message}`
    }
  }
}

export default new SearchImageTool()
