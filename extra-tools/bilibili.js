import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const sixty = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_sixty.js')).href)
const images = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_images.js')).href)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const strip = s => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const count = n => (Number(n) >= 10000 ? `${(Number(n) / 10000).toFixed(1)}万` : String(n ?? 0))
const https = url => (String(url || '').startsWith('//') ? `https:${url}` : String(url || ''))

/** B 站搜索接口需要游客 cookie（buvid3），先访问一次首页拿到 */
async function cookie () {
  const res = await fetch('https://www.bilibili.com', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) })
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']
  return cookies.map(c => c.split(';')[0]).filter(Boolean).join('; ')
}

/** 请求 B 站接口；被风控时返回的是网页而不是 JSON */
async function api (url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com', Cookie: await cookie() },
    signal: AbortSignal.timeout(10000)
  })
  let json
  try {
    json = JSON.parse(await res.text())
  } catch {
    throw new Error(`B 站拦截了这次请求（HTTP ${res.status}），请稍后再试`)
  }
  if (json.code === -404 || json.code === 62002) throw new Error('视频不存在或已被删除')
  if (json.code !== 0) throw new Error(json.message || `接口返回错误（${json.code}）`)
  return json
}

async function search (keyword, limit) {
  const json = await api(`https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}`)
  return (json.data?.result || []).slice(0, limit).map(v => ({
    bvid: v.bvid,
    title: strip(v.title),
    author: v.author,
    duration: v.duration,
    play: count(v.play),
    cover: https(v.pic)
  }))
}

async function video (bvid) {
  return (await api(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`)).data
}

export class BilibiliTool extends CustomTool {
  name = 'bilibili'

  function = {
    name: 'bilibili',
    description: 'B 站视频：search=按关键词搜索视频；video=查看某个视频的详细信息（标题、简介、UP 主、播放点赞等）。' +
      'video 时设 share=true 会把封面和视频信息发到聊天里（用户想看 / 分享某个视频时）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'video'],
          description: 'search=搜索（默认）；video=视频详情'
        },
        keyword: {
          type: 'string',
          description: 'search 时的关键词'
        },
        bvid: {
          type: 'string',
          description: 'video 时的 BV 号或视频链接'
        },
        limit: {
          type: 'number',
          description: 'search 返回条数，默认 5，最多 10'
        },
        share: {
          type: 'boolean',
          description: 'video 时是否把封面和信息发到聊天里'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    try {
      if (args.action === 'video') {
        const bvid = String(args.bvid || '').match(/BV[0-9A-Za-z]{10}/)?.[0]
        if (!bvid) return '请提供 BV 号或视频链接'
        const v = await video(bvid)
        const s = v.stat || {}
        const pub = new Date(v.pubdate * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
        const minutes = Math.floor(v.duration / 60)
        const info = [
          `🎬 ${v.title}`,
          `👤 UP 主：${v.owner?.name}　⏱️ ${minutes}:${String(v.duration % 60).padStart(2, '0')}　📅 ${pub}`,
          `👁️ 播放 ${count(s.view)}　👍 点赞 ${count(s.like)}　🪙 投币 ${count(s.coin)}　⭐ 收藏 ${count(s.favorite)}　💬 弹幕 ${count(s.danmaku)}`,
          `🔗 https://www.bilibili.com/video/${bvid}`
        ].join('\n')
        if (args.share) {
          const result = await images.sendImages(context?.getEvent?.(), [https(v.pic)], info)
          return `${result.startsWith('已发送') ? '已把视频封面和信息发到聊天里，不需要再重复' : result}\n简介：${String(v.desc || '').slice(0, 300)}`
        }
        return `${info}\n简介：${String(v.desc || '无').slice(0, 500)}`
      }

      const keyword = String(args.keyword || '').trim()
      if (!keyword) return '请提供搜索关键词'
      const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 5), 1), 10)
      const list = await search(keyword, limit)
      if (!list.length) return `B 站没有搜到“${keyword}”相关的视频`
      return `B 站搜索“${keyword}”：\n` + list.map((v, i) =>
        `${i + 1}. ${v.title}（UP：${v.author}，${v.duration}，播放 ${v.play}）${v.bvid}`).join('\n') +
        '\n\n要分享某个视频时用 action=video 并设 share=true'
    } catch (err) {
      return `B 站请求失败：${sixty.errorText(err)}`
    }
  }
}

export default new BilibiliTool()
