import { CustomTool } from 'chaite'

const DAY = 24 * 3600 * 1000
const TZ = 8 * 3600 * 1000
const WEEK = ['日', '一', '二', '三', '四', '五', '六']

/** 公历节日：月-日，或「月-第几个-星期几」 */
const SOLAR = [
  ['1-1', '元旦'], ['2-14', '情人节'], ['3-8', '妇女节'], ['3-12', '植树节'], ['3-15', '消费者权益日'],
  ['4-1', '愚人节'], ['5-1', '劳动节'], ['5-4', '青年节'], ['5-2-0', '母亲节'], ['6-1', '儿童节'],
  ['6-3-0', '父亲节'], ['7-1', '建党节'], ['8-1', '建军节'], ['9-10', '教师节'], ['10-1', '国庆节'],
  ['10-31', '万圣夜'], ['11-11', '双十一'], ['11-4-4', '感恩节'], ['12-24', '平安夜'], ['12-25', '圣诞节']
]

/** 农历节日（不含闰月）：月-日 */
const LUNAR = Object.fromEntries([
  ['1-1', '春节'], ['1-15', '元宵节'], ['2-2', '龙抬头'], ['5-5', '端午节'], ['7-7', '七夕节'], ['7-15', '中元节'],
  ['8-15', '中秋节'], ['9-9', '重阳节'], ['10-1', '寒衣节'], ['12-8', '腊八节'], ['12-23', '北方小年'], ['12-24', '南方小年']
])

/** 二十四节气，按太阳黄经从 0°（春分）起每 15° 一个 */
const TERMS = ['春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑', '白露',
  '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至', '小寒', '大寒', '立春', '雨水', '惊蛰']

const LUNAR_MONTHS = Object.fromEntries([
  ['正月', 1], ['二月', 2], ['三月', 3], ['四月', 4], ['五月', 5], ['六月', 6],
  ['七月', 7], ['八月', 8], ['九月', 9], ['十月', 10], ['十一月', 11], ['冬月', 11],
  ['十二月', 12], ['腊月', 12]
])
const LUNAR_DAYS = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十']

const lunarFormat = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' })

/** 北京时间某天 0 点的时间戳（day 为从 1970-01-01 起的北京日序号） */
const dayStart = day => day * DAY - TZ
const toDay = ms => Math.floor((ms + TZ) / DAY)
const ymd = day => {
  const d = new Date(day * DAY)
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: d.getUTCDay() }
}

/** 农历月日；leap 为闰月 */
function lunar (day) {
  const parts = lunarFormat.formatToParts(new Date(dayStart(day) + 12 * 3600 * 1000))
  const month = parts.find(p => p.type === 'month')?.value || ''
  const d = Number(parts.find(p => p.type === 'day')?.value)
  return { leap: month.startsWith('闰'), m: LUNAR_MONTHS[month.replace(/^闰/, '')], d, text: `${month}${LUNAR_DAYS[d - 1] || d}` }
}

/** 太阳视黄经（度），Meeus 低精度算法，误差约 0.01°（节气时刻误差十几分钟） */
function sunLongitude (ms) {
  const T = (ms / DAY + 2440587.5 - 2451545) / 36525
  const rad = Math.PI / 180
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * rad
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M)
  const omega = (125.04 - 1934.136 * T) * rad
  return L0 + C - 0.00569 - 0.00478 * Math.sin(omega)
}

/** 这一天交的节气（没有时返回空串） */
function termOf (day) {
  const a = Math.floor(sunLongitude(dayStart(day)) / 15)
  const b = Math.floor(sunLongitude(dayStart(day + 1)) / 15)
  return b > a ? TERMS[((b % 24) + 24) % 24] : ''
}

/** 这一天的所有节日和节气 */
function eventsOf (day) {
  const { m, d, w } = ymd(day)
  const names = []
  for (const [rule, name] of SOLAR) {
    const [rm, a, b] = rule.split('-').map(Number)
    if (rm !== m) continue
    if (b === undefined ? a === d : w === b && Math.ceil(d / 7) === a) names.push(name)
  }
  const l = lunar(day)
  if (!l.leap && LUNAR[`${l.m}-${l.d}`]) names.push(LUNAR[`${l.m}-${l.d}`])
  const next = lunar(day + 1)
  if (!next.leap && next.m === 1 && next.d === 1) names.push('除夕')
  const term = termOf(day)
  if (term) names.push(term === '清明' ? '清明（清明节）' : `${term}（节气）`)
  return names
}

const label = (day, today) => {
  const { y, m, d, w } = ymd(day)
  const left = day - today
  const when = left === 0 ? '今天' : left === 1 ? '明天' : left === 2 ? '后天' : `还有 ${left} 天`
  return `${y !== ymd(today).y ? `${y}年` : ''}${m}月${d}日 周${WEEK[w]}（农历${lunar(day).text}），${when}`
}

export class FestivalTool extends CustomTool {
  name = 'festival'

  function = {
    name: 'festival',
    description: '查询近期的节日和二十四节气（公历节日、春节中秋等农历节日、节气），或者某个节日 / 节气是哪天、还有几天。' +
      '用户问“最近有什么节日”“下个节气”“中秋还有几天”“今年冬至是哪天”时调用。',
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '要找的节日或节气名，如 中秋、冬至、春节；不填为列出近期的节日'
        },
        days: {
          type: 'number',
          description: '列出接下来多少天内的节日，默认 30，最多 366'
        }
      },
      required: []
    }
  }

  async run (args) {
    const today = toDay(Date.now())
    const keyword = String(args.keyword ?? '').trim()
    if (keyword) {
      // 先按原词找；找不到再去掉末尾的“节”（如“冬至节”），避免“春节”被截成“春”匹配到立春
      for (const kw of [...new Set([keyword, keyword.replace(/节$/, '')])].filter(Boolean)) {
        const found = []
        for (let day = today; day <= today + 400 && found.length < 2; day++) {
          const hit = eventsOf(day).find(n => n.includes(kw))
          if (hit) found.push(`${hit.replace(/（节气）$/, '')}：${label(day, today)}`)
        }
        if (found.length) return found.join('\n')
      }
      return `一年内没有找到“${keyword}”这个节日或节气`
    }
    const days = Math.min(Math.max(Math.floor(Number(args.days)) || 30, 1), 366)
    const lines = []
    for (let day = today; day <= today + days; day++) {
      const names = eventsOf(day)
      if (names.length) lines.push(`${names.join('、')}：${label(day, today)}`)
    }
    const { y, m, d, w } = ymd(today)
    const head = `今天 ${y}年${m}月${d}日 周${WEEK[w]}，农历${lunar(today).text}`
    return `${head}\n接下来 ${days} 天的节日和节气：\n${lines.join('\n') || '没有'}`
  }
}

export default new FestivalTool()
