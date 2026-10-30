import { CustomTool } from 'chaite'

const TIMEOUT = 15000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MAX_TEXT = 1500

const clip = text => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text)
const strip = html => String(html ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim()

const get = (url, headers = {}) => fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(TIMEOUT) })

/** 百度百科：先用词条卡片接口，没有结果时读词条页面的简介 */
async function baike (keyword) {
  try {
    const res = await get(`https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key=${encodeURIComponent(keyword)}&bk_length=1200`)
    const data = await res.json()
    if (data?.title && data.abstract) {
      const card = (data.card || []).slice(0, 8).map(c => `${c.name || c.key}：${(c.value || []).map(strip).join('、')}`).filter(l => !l.endsWith('：'))
      return [`【百度百科】${data.title}${data.desc ? `（${data.desc}）` : ''}`, clip(strip(data.abstract)), ...(card.length ? ['', ...card] : []), `链接：${data.url || `https://baike.baidu.com/item/${encodeURIComponent(keyword)}`}`].join('\n')
    }
  } catch {}
  const url = `https://baike.baidu.com/item/${encodeURIComponent(keyword)}`
  const res = await get(url)
  const html = await res.text()
  const desc = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1]
  const title = strip(html.match(/<title>([^<]*)<\/title>/i)?.[1] || keyword).replace(/_百度百科$/, '')
  if (!desc || /百度百科是一部/.test(desc)) return ''
  return `【百度百科】${title}\n${clip(strip(desc))}\n链接：${res.url || url}`
}

/** 维基百科：先搜索拿到词条名，再取词条摘要（简体中文） */
async function wiki (keyword, lang) {
  const host = `https://${lang}.wikipedia.org`
  const search = await (await get(`${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(keyword)}&srlimit=3&format=json`)).json()
  const hits = search?.query?.search || []
  if (!hits.length) return ''
  const title = hits[0].title
  const res = await get(`${host}/api/rest_v1/page/summary/${encodeURIComponent(title)}`, lang === 'zh' ? { 'Accept-Language': 'zh-CN' } : {})
  if (!res.ok) throw new Error(`维基百科返回 HTTP ${res.status}`)
  const data = await res.json()
  const others = hits.slice(1).map(h => h.title)
  return [`【维基百科】${data.title || title}${data.description ? `（${data.description}）` : ''}`, clip(data.extract || strip(hits[0].snippet)),
    `链接：${data.content_urls?.desktop?.page || `${host}/wiki/${encodeURIComponent(title)}`}`, ...(others.length ? [`相关词条：${others.join('、')}`] : [])].join('\n')
}

const reason = err => (err?.name === 'TimeoutError' ? '请求超时' : err?.message || String(err))

export class EncyclopediaTool extends CustomTool {
  name = 'encyclopedia'

  function = {
    name: 'encyclopedia',
    description: '查百科词条的简介：百度百科（baike）、维基百科（wiki）。用户问“xx 是什么”“介绍一下 xx”这类人物、事物、概念时调用；' +
      '要查最新消息用 web_search。默认先查百度百科，没有再查维基百科。',
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '词条名，如 鲁迅、量子纠缠'
        },
        source: {
          type: 'string',
          enum: ['auto', 'baike', 'wiki'],
          description: 'auto=先百度百科再维基百科（默认）；baike=只查百度百科；wiki=只查维基百科'
        },
        lang: {
          type: 'string',
          enum: ['zh', 'en', 'ja'],
          description: '维基百科的语言，默认 zh'
        }
      },
      required: ['keyword']
    }
  }

  async run (args) {
    const keyword = String(args.keyword ?? '').trim()
    if (!keyword) return '请提供要查的词条'
    const source = ['baike', 'wiki'].includes(args.source) ? args.source : 'auto'
    const lang = ['zh', 'en', 'ja'].includes(args.lang) ? args.lang : 'zh'
    const errors = []
    for (const [name, fn] of [['baike', () => baike(keyword)], ['wiki', () => wiki(keyword, lang)]]) {
      if (source !== 'auto' && source !== name) continue
      try {
        const text = await fn()
        if (text) return text
        errors.push(`${name === 'baike' ? '百度百科' : '维基百科'}没有这个词条`)
      } catch (err) {
        errors.push(`${name === 'baike' ? '百度百科' : '维基百科'}查询失败（${reason(err)}${name === 'wiki' ? '，国内服务器一般连不上维基百科' : ''}）`)
      }
    }
    return `没有查到“${keyword}”：${errors.join('；')}。可以换个说法，或用 web_search 搜索`
  }
}

export default new EncyclopediaTool()
