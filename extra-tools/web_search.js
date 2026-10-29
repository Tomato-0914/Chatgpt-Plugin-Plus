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

function stripTags (html = '') {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

/** Bing 的跳转链接 bing.com/ck/a?...&u=a1<base64url> 还原成真实地址 */
function decodeBingUrl (url) {
  try {
    const parsed = new URL(url)
    const target = parsed.searchParams.get('u')
    if (parsed.hostname.endsWith('bing.com') && parsed.pathname === '/ck/a' && target?.startsWith('a1')) {
      const decoded = Buffer.from(target.slice(2), 'base64url').toString()
      if (/^https?:\/\//.test(decoded)) return decoded
    }
  } catch {}
  return url
}

export function parseBingResults (html, count) {
  const results = []
  for (const item of html.split('<li class="b_algo"').slice(1)) {
    if (results.length >= count) break
    // 标题在 h2 里；item 开头的第一个 <a> 往往是站点图标
    const anchor = item.match(/<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!anchor) continue
    const url = decodeBingUrl(decodeEntities(anchor[1]))
    const title = stripTags(anchor[2])
    if (!url.startsWith('http') || !title) continue
    const snippet = item.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    results.push({ title, url, snippet: snippet ? stripTags(snippet[1]).slice(0, 300) : '' })
  }
  return results
}

export function parse360Results (html, count) {
  const results = []
  for (const item of html.split('<li class="res-list"').slice(1)) {
    if (results.length >= count) break
    const anchor = item.match(/<h3[^>]*>[\s\S]*?(<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>)/i)
    if (!anchor) continue
    // 优先取真实地址 data-mdurl，否则用跳转链接
    const real = anchor[1].match(/data-mdurl="([^"]+)"/i)
    let url = decodeEntities(real ? real[1] : anchor[2])
    if (url.startsWith('//')) url = 'https:' + url
    else if (url.startsWith('/')) url = 'https://www.so.com' + url
    const title = stripTags(anchor[3])
    if (!title || title.includes('广告')) continue
    const desc = item.match(/<p class="res-desc"[^>]*>([\s\S]*?)<\/p>/i) ||
      item.match(/<div class="res-rich[^>]*>([\s\S]*?)<\/div>/i)
    results.push({ title, url, snippet: desc ? stripTags(desc[1]).slice(0, 300) : '' })
  }
  return results
}

/**
 * 结果是否与关键词相关：Bing 怀疑请求来自机器人时会返回随机的无关结果，
 * 标题和摘要里一个关键词都没有时视为无效，换下一个搜索引擎
 */
function relevant (query, results) {
  const words = query.toLowerCase().split(/[\s,，。、;；:：!！?？"'“”‘’()（）[\]【】]+/).filter(w => w.length >= 2)
  if (!words.length) return true
  return results.some(r => {
    const text = `${r.title} ${r.snippet}`.toLowerCase()
    return words.some(w => text.includes(w))
  })
}

const ENGINES = [
  { label: 'Bing', url: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-hans&cc=CN`, parse: parseBingResults },
  { label: '360搜索', url: q => `https://www.so.com/s?q=${encodeURIComponent(q)}`, parse: parse360Results }
]

/** 读取网页正文（简化版，完整功能见 fetch_webpage） */
async function readPage (url, maxLength) {
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(8000) })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    let html = (await res.text()).replace(/<(script|style|noscript|svg|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, '')
    html = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] || html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] || html
    const text = stripTags(html.replace(/<\/(p|div|li|h[1-6]|br)>/gi, ' \n'))
    return text ? { content: text.slice(0, maxLength) } : { error: '没有可读取的文字' }
  } catch (err) {
    return { error: err.name === 'TimeoutError' ? '请求超时' : err.message }
  }
}

export class WebSearchTool extends CustomTool {
  name = 'web_search'

  function = {
    name: 'web_search',
    description: '联网搜索。遇到最新消息、实时数据、你不确定或可能过时的知识时调用，返回搜索结果标题、链接、摘要，并读取前几条结果的正文。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，尽量简洁具体'
        },
        count: {
          type: 'number',
          description: '返回结果条数，默认 5，最大 10'
        },
        read: {
          type: 'number',
          description: '读取前几条结果的网页正文，默认 2，0 表示只看摘要'
        }
      },
      required: ['query']
    }
  }

  async run (args) {
    const query = String(args.query || '').trim()
    if (!query) return '请提供搜索关键词'
    const count = Math.min(Math.max(Number(args.count) || 5, 1), 10)
    const readCount = Math.min(Math.max(Number(args.read ?? 2) || 0, 0), 3)

    const errors = []
    for (const engine of ENGINES) {
      let results
      try {
        const res = await fetch(engine.url(query), { headers: HEADERS, signal: AbortSignal.timeout(10000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        results = engine.parse(await res.text(), count)
      } catch (err) {
        errors.push(`${engine.label}：${err.name === 'TimeoutError' ? '请求超时' : err.message}`)
        continue
      }
      if (!results.length) {
        errors.push(`${engine.label}：无结果`)
        continue
      }
      if (!relevant(query, results)) {
        errors.push(`${engine.label}：结果与关键词无关`)
        continue
      }

      const pages = await Promise.all(results.slice(0, readCount).map(r => readPage(r.url, 2500)))
      const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
      const lines = [`搜索：${query}`, `引擎：${engine.label}，查询时间：${now}（北京时间）`]
      results.forEach((r, i) => {
        lines.push('', `[${i + 1}] ${r.title}`, `链接：${r.url}`)
        if (r.snippet) lines.push(`摘要：${r.snippet}`)
        if (pages[i]?.content) lines.push('正文：', pages[i].content)
        else if (pages[i]?.error) lines.push(`（正文读取失败：${pages[i].error}）`)
      })
      lines.push('', '提示：摘要可能过时，时效性信息以正文和查询时间为准；需要某条结果的完整内容时用 fetch_webpage 读取。')
      return lines.join('\n')
    }
    return `搜索失败：${errors.join('；')}`
  }
}

export default new WebSearchTool()
