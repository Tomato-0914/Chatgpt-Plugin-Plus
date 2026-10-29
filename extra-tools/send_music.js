import crypto from 'node:crypto'
import { CustomTool } from 'chaite'

/** QQ 音乐搜索接口；请求频繁时会返回 search.code 2001（限流），此时返回 null 交给备用接口 */
async function searchMain (keyword, count) {
  const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      comm: { uin: '0', authst: '', ct: 29 },
      search: {
        method: 'DoSearchForQQMusicMobile',
        module: 'music.search.SearchCgiService',
        param: {
          grp: 1,
          num_per_page: count,
          page_num: 1,
          query: keyword,
          remoteplace: 'miniapp.1109523715',
          search_type: 0,
          searchid: String(Date.now())
        }
      }
    }),
    signal: AbortSignal.timeout(10000)
  })
  const data = await res.json()
  if (data?.code !== 0 || data.search?.code !== 0) return null
  const body = data.search?.data?.body || {}
  return (body.song?.list || body.item_song || []).map(song => ({
    mid: song.mid,
    title: String(song.title || song.name || '未知').replace(/<\/?em>/g, ''),
    artist: (song.singer || []).map(s => s.name).join('/') || '未知',
    album: song.album?.name || '',
    albumMid: song.album?.mid || ''
  }))
}

/** 备用：搜索框联想接口，结果较少、没有专辑信息（卡片没有封面） */
async function searchSmartbox (keyword) {
  const res = await fetch(`https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?format=json&key=${encodeURIComponent(keyword)}`, {
    headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000)
  })
  const data = await res.json()
  return (data?.data?.song?.itemlist || []).map(song => ({
    mid: song.mid,
    title: song.name || '未知',
    artist: song.singer || '未知',
    album: '',
    albumMid: ''
  }))
}

/** 搜索 QQ 音乐，返回歌曲列表 */
async function searchQQMusic (keyword, count) {
  let songs = null
  try {
    songs = await searchMain(keyword, count)
  } catch {}
  if (!songs?.length) songs = await searchSmartbox(keyword)
  return songs.filter(song => song.mid)
}

/** 自定义音乐卡片（OneBot 格式，由协议端签名生成；歌手放 content，NapCat / LLOneBot 只认这个字段） */
function musicCard (song) {
  const code = crypto.createHash('md5').update(`${song.mid}q;z(&l~sdf2!nK`).digest('hex').substring(0, 5).toUpperCase()
  return {
    type: 'music',
    data: {
      type: 'custom',
      url: `https://y.qq.com/n/yqq/song/${song.mid}.html`,
      audio: `http://c6.y.qq.com/rsc/fcgi-bin/fcg_pyq_play.fcg?songmid=${song.mid}&songtype=1&fromtag=50&code=${code}`,
      title: song.title,
      ...(song.artist !== '未知' ? { content: song.artist } : {}),
      ...(song.albumMid ? { image: `http://y.gtimg.cn/music/photo_new/T002R150x150M000${song.albumMid}.jpg` } : {})
    }
  }
}

function sent (ret) {
  if (!ret) return false
  if (Array.isArray(ret.message_id)) return ret.message_id.length > 0
  return ret.message_id != null && ret.message_id !== ''
}

export class SendMusicTool extends CustomTool {
  name = 'send_music'

  function = {
    name: 'send_music',
    description: '搜索 QQ 音乐并把歌曲以音乐卡片发到当前聊天（点开可以直接听）。用户想听歌、点歌、分享某首歌时调用。' +
      '只有歌手名时可以设 random 随机挑一首。不确定是哪首时先用 action=search 列出结果再选。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['send', 'search'],
          description: 'send=搜索并发送卡片（默认）；search=只列出搜索结果，不发送'
        },
        keyword: {
          type: 'string',
          description: '歌名，或“歌名 歌手”'
        },
        index: {
          type: 'number',
          description: '发送搜索结果中的第几首，默认 1'
        },
        random: {
          type: 'boolean',
          description: '从前 20 个结果里随机选一首（只给了歌手名时使用）'
        }
      },
      required: ['keyword']
    }
  }

  async run (args, context) {
    const keyword = String(args.keyword || '').trim()
    if (!keyword) return '请提供歌名'
    let songs
    try {
      songs = await searchQQMusic(keyword, args.action === 'search' ? 10 : 20)
    } catch (err) {
      return `搜索失败：${err.name === 'TimeoutError' ? '请求超时' : err.message}`
    }
    if (!songs.length) return `没有找到“${keyword}”相关的歌曲`

    if (args.action === 'search') {
      return `“${keyword}”的搜索结果：\n` +
        songs.slice(0, 10).map((s, i) => `${i + 1}. ${s.title} - ${s.artist}${s.album ? `（${s.album}）` : ''}`).join('\n') +
        '\n\n用 index 指定第几首发送'
    }

    const e = context?.getEvent?.()
    if (typeof e?.reply !== 'function') return '当前没有可用的聊天，无法发送'
    const song = args.random
      ? songs[Math.floor(Math.random() * songs.length)]
      : songs[Math.min(Math.max(Math.floor(Number(args.index) || 1), 1), songs.length) - 1]
    const card = musicCard(song)
    try {
      const ret = await e.reply(card)
      if (sent(ret)) return `已发送音乐卡片：${song.title} - ${song.artist}，不需要再重复歌曲信息`
      const reason = ret?.error?.[0]?.message || ret?.error?.[0] || '没有返回消息 ID'
      return `音乐卡片发送失败（${reason}），可以改为告诉用户歌曲链接：${song.title} - ${song.artist} ${card.data.url}`
    } catch (err) {
      return `音乐卡片发送失败（${err.message}），可以改为告诉用户歌曲链接：${song.title} - ${song.artist} ${card.data.url}`
    }
  }
}

export default new SendMusicTool()
