import { CustomTool } from 'chaite'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
}

function decodeEntities (text = '') {
  return text
    .replace(/&nbsp;|&ensp;|&emsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

/** 网页 HTML 转纯文本：去掉脚本、样式、导航等，优先取 article / main 里的正文 */
export function htmlToText (html) {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim()
  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|template|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, '')
  body = body.match(/<article\b[\s\S]*?<\/article>/i)?.[0] || body.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ||
    body.match(/<body\b[\s\S]*?<\/body>/i)?.[0] || body
  const text = decodeEntities(body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text }
}

export class FetchWebpageTool extends CustomTool {
  name = 'fetch_webpage'

  function = {
    name: 'fetch_webpage',
    description: '读取网页正文。用户发来链接、或需要查看搜索结果的详细内容时调用，返回网页标题和纯文本正文。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '网页地址，以 http:// 或 https:// 开头'
        },
        max_length: {
          type: 'number',
          description: '正文最多返回的字数，默认 4000，最大 12000'
        }
      },
      required: ['url']
    }
  }

  async run (args) {
    const url = String(args.url || '').trim()
    if (!/^https?:\/\//i.test(url)) return '网址必须以 http:// 或 https:// 开头'
    const maxLength = Math.min(Math.max(Number(args.max_length) || 4000, 200), 12000)
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) })
      if (!res.ok) return `读取失败：HTTP ${res.status}`
      const type = res.headers.get('content-type') || ''
      const raw = await res.text()
      let { title, text } = /html|xml/i.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : { title: '', text: raw.trim() }
      if (!text) return '网页没有可读取的文字内容（可能需要登录或由脚本动态加载）'
      const truncated = text.length > maxLength
      if (truncated) text = text.slice(0, maxLength)
      return [
        title && `标题：${title}`,
        `地址：${res.url || url}`,
        '',
        text,
        truncated ? `\n（正文过长，已截取前 ${maxLength} 字）` : ''
      ].filter(line => line !== false).join('\n').trim()
    } catch (err) {
      return `读取失败：${err.name === 'TimeoutError' ? '请求超时' : err.message}`
    }
  }
}

export default new FetchWebpageTool()
