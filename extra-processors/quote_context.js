import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PreProcessor, asyncLocalStorage } from 'chaite'

/**
 * 引用消息
 *
 * ikechan 版对话时只把被引用消息里的图片带给 AI，不带文字（引用文件时只有一个常常取不到的下载地址），
 * 群友引用了一条消息问“这说的什么”“这个文件写了啥”，AI 看不到被引用的内容，会说“你没发消息 / 图片 / 文件”。
 * 这个前置处理器在用户消息前面加上被引用消息的发送人、时间、内容（以及它又引用的那条），
 * 文件、语音、视频提示可以用 file_read 读取，合并转发提示用 forward_msg 读取。
 * 官方机器人没收到被引用的消息时（没有 @ 机器人的消息收不到）到同群的其他协议机器人的消息记录里找。
 */

const quote = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_quote.js')).href)

/** 被引用消息的说明，包在开头结尾标记里，让 AI 分得清哪部分是用户这次说的话 */
export function quoteBlock (text, hasText = true) {
  return `【这条消息引用了下面这条消息（不是用户这次说的话）】\n${text}\n${hasText ? '【引用结束，下面是用户这次说的话】\n' : '【引用结束，用户只引用了这条消息，没有说话】'}`
}

export class QuoteContextProcessor extends PreProcessor {
  name = 'quote_context'
  description = '把被引用消息的发送人和内容带给 AI（ikechan 版只带引用里的图片）'
  type = 'pre'

  async process (message) {
    const e = asyncLocalStorage.getStore()?.getEvent?.()
    if (!e || (!e.source && !e.reply_id) || !Array.isArray(message?.content)) return message
    // 已经带过了（如插件开了引用文字），不重复
    if (message.content.some(c => c?.type === 'text' && /本条消息对以下消息进行了引用回复|这条消息引用了下面这条消息/.test(c.text || ''))) return message
    try {
      const text = await quote.replyText(e, 1, { readable: true })
      if (!text || text.startsWith('这条消息没有引用')) return message
      // 插件自己加的“文件下载地址为获取失败”只会误导，去掉
      for (const c of message.content) {
        if (c?.type === 'text') c.text = String(c.text || '').replace(/本条消息对一个文件进行了引用回复：该文件的下载地址为获取失败\n\n本条消息内容：\n/, '')
      }
      // 和用户说的话放在同一段文字前面；没有文字（只有图片）时单独加一段
      const first = message.content.find(c => c?.type === 'text' && String(c.text || '').trim())
      if (first) first.text = quoteBlock(text) + first.text
      else message.content.push({ type: 'text', text: quoteBlock(text, false) })
    } catch (err) {
      globalThis.logger?.debug?.('[quote_context] 读取引用消息失败', err)
    }
    return message
  }
}

export default new QuoteContextProcessor()
