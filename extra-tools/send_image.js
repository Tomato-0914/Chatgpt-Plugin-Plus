import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const images = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_images.js')).href)

export class SendImageTool extends CustomTool {
  name = 'send_image'

  function = {
    name: 'send_image',
    description: '把网上的图片（图片链接）直接以图片消息发到当前聊天，可附一句话。搜到图片链接、用户想看某张图时调用，不要只把链接贴给用户。',
    parameters: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: '图片地址，http(s) 开头，最多 5 张'
        },
        text: {
          type: 'string',
          description: '跟图片一起发的文字，可不填'
        }
      },
      required: ['urls']
    }
  }

  async run (args, context) {
    const urls = (Array.isArray(args.urls) ? args.urls : [args.urls])
      .map(u => String(u ?? '').trim()).filter(u => /^https?:\/\//i.test(u))
    if (!urls.length) return '请提供以 http:// 或 https:// 开头的图片地址'
    if (urls.length > 5) return '一次最多发 5 张图片'
    return images.sendImages(context?.getEvent?.(), urls, args.text)
  }
}

export default new SendImageTool()
