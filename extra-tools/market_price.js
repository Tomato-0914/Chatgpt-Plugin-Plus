import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const sixty = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_sixty.js')).href)

const TIMEOUT = 15000
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9'
}

const DEFAULT_CURRENCIES = ['美元', '欧元', '日元', '港币', '英镑']

/** 币种代码 / 常用叫法 → 中国银行牌价上的名称 */
const ALIASES = Object.fromEntries([
  ['USD', '美元'], ['美金', '美元'], ['EUR', '欧元'], ['JPY', '日元'], ['日币', '日元'], ['HKD', '港币'],
  ['港元', '港币'], ['GBP', '英镑'], ['AUD', '澳大利亚元'], ['澳元', '澳大利亚元'], ['CAD', '加拿大元'], ['加元', '加拿大元'],
  ['SGD', '新加坡元'], ['新币', '新加坡元'], ['CHF', '瑞士法郎'], ['KRW', '韩国元'], ['韩元', '韩国元'], ['TWD', '新台币'],
  ['台币', '新台币'], ['THB', '泰国铢'], ['泰铢', '泰国铢'], ['RUB', '卢布'], ['MOP', '澳门元'], ['澳门币', '澳门元'],
  ['NZD', '新西兰元'], ['MYR', '林吉特'], ['马币', '林吉特'], ['PHP', '菲律宾比索'], ['SEK', '瑞典克朗'], ['DKK', '丹麦克朗'],
  ['NOK', '挪威克朗'], ['INR', '印度卢比'], ['IDR', '印尼卢比'], ['VND', '越南盾'], ['AED', '阿联酋迪拉姆'], ['SAR', '沙特里亚尔'],
  ['TRY', '土耳其里拉'], ['BRL', '巴西雷亚尔'], ['ZAR', '南非兰特'], ['MXN', '墨西哥比索']
])
/** 牌价名称 → 币种代码（备用数据源按代码查） */
const CODES = Object.fromEntries(Object.entries(ALIASES).filter(([k]) => /^[A-Z]{3}$/.test(k)).map(([code, name]) => [name, code]))

/** 新浪行情代码 */
const METALS = {
  gold: [
    { code: 'gds_AU9999', label: '上海金 Au99.99', unit: '元/克' },
    { code: 'gds_AUTD', label: '上海金 Au(T+D)', unit: '元/克' },
    { code: 'hf_XAU', label: '伦敦金（现货）', unit: '美元/盎司', perGram: true },
    { code: 'hf_GC', label: '纽约金（COMEX 期货）', unit: '美元/盎司', perGram: true }
  ],
  silver: [
    { code: 'gds_AGTD', label: '上海银 Ag(T+D)', unit: '元/千克' },
    { code: 'hf_XAG', label: '伦敦银（现货）', unit: '美元/盎司', perGram: true }
  ]
}
const GRAMS_PER_OUNCE = 31.1034768

const now = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const strip = html => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
/** 按响应头或网页声明的编码解码（国内财经站点有的还是 GBK） */
function decode (buffer, contentType) {
  const head = Buffer.from(buffer.slice(0, 2048)).toString('latin1')
  const declared = String(contentType || '').match(/charset=["']?([\w-]+)/i)?.[1] || head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || 'utf-8'
  try {
    return new TextDecoder(/^(gb2312|gbk|gb18030)$/i.test(declared) ? 'gb18030' : declared).decode(buffer)
  } catch {
    return Buffer.from(buffer).toString('utf8')
  }
}

const reason = err => (err?.name === 'TimeoutError' ? '请求超时' : err?.message || String(err))

function currencies (input) {
  const names = String(input ?? '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean)
    .map(s => ALIASES[s.toUpperCase()] || ALIASES[s] || s)
  return names.length ? [...new Set(names)] : DEFAULT_CURRENCIES
}

/** 中国银行外汇牌价表：牌价是每 100 外币，换算成每 1 外币 */
function parseBoc (html) {
  const per = v => (Number.isFinite(parseFloat(v)) ? Number((parseFloat(v) / 100).toPrecision(6)) : null)
  const rows = []
  for (const row of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const c = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => strip(m[1]))
    if (c.length < 7 || !c[0] || !/\d/.test(c[6])) continue
    rows.push({ name: c[0], buyRemit: per(c[1]), buyCash: per(c[2]), sellRemit: per(c[3]), sellCash: per(c[4]), middle: per(c[5]), time: c[6] })
  }
  return rows
}

async function exchange (input, amount) {
  const names = currencies(input)
  try {
    const res = await fetch('https://www.boc.cn/sourcedb/whpj/', { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const all = parseBoc(decode(await res.arrayBuffer(), res.headers.get('content-type')))
    if (!all.length) throw new Error('牌价页面解析失败')
    const rows = names.map(n => all.find(r => r.name === n)).filter(Boolean)
    const missing = names.filter(n => !all.some(r => r.name === n))
    if (!rows.length) return `中国银行牌价里没有：${missing.join('、')}`
    const show = v => (v === null ? '—' : v)
    const lines = [`中国银行外汇牌价（发布时间 ${rows[0].time}，查询时间 ${now()}），单位：人民币 / 1 外币`]
    for (const r of rows) {
      lines.push(`${r.name}：现汇买入 ${show(r.buyRemit)}｜现钞买入 ${show(r.buyCash)}｜现汇卖出 ${show(r.sellRemit)}｜现钞卖出 ${show(r.sellCash)}｜中行折算价 ${show(r.middle)}`)
      if (amount && r.middle !== null) lines.push(`  ${amount} ${r.name} ≈ ${(amount * r.middle).toFixed(2)} 元（按中行折算价）`)
    }
    if (missing.length) lines.push(`没有找到：${missing.join('、')}`)
    lines.push('说明：买入价是银行收你外币的价格（你卖外币），卖出价是银行卖给你外币的价格（你购汇）。')
    return lines.join('\n')
  } catch (err) {
    // 中国银行页面打不开时用每天更新一次的国际中间价
    const res = await fetch('https://open.er-api.com/v6/latest/CNY', { signal: AbortSignal.timeout(TIMEOUT) })
    const data = await res.json()
    if (data.result !== 'success') throw new Error(`中国银行牌价：${reason(err)}；备用接口：${data['error-type'] || '返回失败'}`)
    const lines = [`国际参考汇率（中国银行牌价获取失败：${reason(err)}；此数据每天更新一次，更新于 ${data.time_last_update_utc}）`]
    for (const name of names) {
      const perCny = data.rates?.[CODES[name]]
      if (!perCny) {
        lines.push(`${name}：暂无数据`)
        continue
      }
      const rate = Number((1 / perCny).toPrecision(6))
      lines.push(`1 ${name} ≈ ${rate} 元${amount ? `，${amount} ${name} ≈ ${(amount * rate).toFixed(2)} 元` : ''}`)
    }
    return lines.join('\n')
  }
}

/** 新浪行情：var hq_str_代码="字段,字段,..."；hf_ / gds_ 字段：0 最新价，4 最高，5 最低，6 时间，7 昨收，12 日期 */
function parseSina (text) {
  const quotes = {}
  for (const m of text.matchAll(/var hq_str_(\w+)="([^"]*)"/g)) if (m[2]) quotes[m[1]] = m[2].split(',')
  return quotes
}

async function metals (metal) {
  const items = metal === 'all' ? [...METALS.gold, ...METALS.silver] : METALS[metal]
  const res = await fetch(`https://hq.sinajs.cn/list=${[...items.map(i => i.code), 'fx_susdcny'].join(',')}`, {
    headers: { ...HEADERS, Referer: 'https://finance.sina.com.cn' },
    signal: AbortSignal.timeout(TIMEOUT)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const quotes = parseSina(new TextDecoder('gb18030').decode(await res.arrayBuffer()))
  if (!items.some(i => quotes[i.code])) throw new Error('行情接口没有返回数据')
  const fx = quotes.fx_susdcny
  const usdCny = fx ? (parseFloat(fx[1]) + parseFloat(fx[2])) / 2 : NaN
  const lines = [`贵金属实时行情（查询时间 ${now()}）`]
  for (const item of items) {
    const f = quotes[item.code]
    const price = parseFloat(f?.[0])
    if (!Number.isFinite(price) || price <= 0) {
      lines.push(`${item.label}：暂无数据`)
      continue
    }
    let line = `${item.label}：${price} ${item.unit}`
    if (item.perGram && Number.isFinite(usdCny)) line += `（约 ${(price * usdCny / GRAMS_PER_OUNCE).toFixed(2)} 元/克）`
    const prev = parseFloat(f[7])
    if (Number.isFinite(prev) && prev > 0) {
      const change = price - prev
      const sign = change >= 0 ? '+' : ''
      line += `，较昨收 ${sign}${change.toFixed(2)}（${sign}${(change / prev * 100).toFixed(2)}%）`
    }
    line += `，今日 ${f[5]}~${f[4]}，行情时间 ${f[12] || ''} ${f[6] || ''}`.trimEnd()
    lines.push(line)
  }
  if (Number.isFinite(usdCny)) lines.push(`美元兑人民币按 ${usdCny.toFixed(4)} 折算`)
  lines.push('说明：金店首饰金价在上海金基础上另加加工费和品牌溢价，通常明显更高，以门店报价为准。')
  return lines.join('\n')
}

/** 今日油价（60s API），省份不填为北京 */
async function oil (province) {
  const region = String(province ?? '').trim().replace(/(省|市|自治区|壮族自治区|回族自治区|维吾尔自治区|特别行政区)$/, '')
  const data = await sixty.fetch60s(`/fuel-price${region ? `?region=${encodeURIComponent(region)}` : ''}`)
  const lines = [`${data.region || region || '北京'}今日油价${data.updated ? `（更新于 ${data.updated}）` : ''}`,
    ...(data.items || []).map(i => `${i.name}：${i.price_desc || i.price}`)]
  const trend = data.trend || {}
  if (trend.next_adjustment_date) lines.push(`下次调价窗口：${trend.next_adjustment_date}${trend.change_liter_desc || trend.direction ? `，${trend.change_liter_desc || trend.direction}` : ''}`)
  return lines.join('\n')
}

export class MarketPriceTool extends CustomTool {
  name = 'market_price'

  function = {
    name: 'market_price',
    description: '查询实时行情：外汇汇率（rate，中国银行外汇牌价，含现汇 / 现钞买入卖出价和中行折算价，可把外币金额换算成人民币）、' +
      '黄金白银价格（metal，上海金、伦敦金、纽约金、白银）、今日油价（oil，92 / 95 / 98 号汽油、0 号柴油和下次调价）。' +
      '用户问汇率、今日金价银价、油价时调用，不要用 web_search。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['rate', 'metal', 'oil'],
          description: 'rate=汇率（默认）；metal=黄金白银；oil=油价'
        },
        currencies: {
          type: 'string',
          description: 'action=rate 时的币种，代码或中文都行，多个用逗号分隔，如 "USD,日元"；默认美元、欧元、日元、港币、英镑'
        },
        amount: {
          type: 'number',
          description: 'action=rate 时要换算成人民币的外币金额（可选）'
        },
        province: {
          type: 'string',
          description: 'action=oil 时的省份，如 广东、上海，默认北京'
        },
        metal: {
          type: 'string',
          enum: ['gold', 'silver', 'all'],
          description: 'action=metal 时的品种：gold=黄金（默认）、silver=白银、all=全部'
        }
      },
      required: []
    }
  }

  async run (args) {
    try {
      if (args.action === 'oil') return await oil(args.province)
      if (args.action === 'metal') return await metals(['gold', 'silver', 'all'].includes(args.metal) ? args.metal : 'gold')
      return await exchange(args.currencies, Number(args.amount) > 0 ? Number(args.amount) : 0)
    } catch (err) {
      return `查询失败：${reason(err)}`
    }
  }
}

export default new MarketPriceTool()
