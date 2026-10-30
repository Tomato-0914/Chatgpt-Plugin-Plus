/**
 * QQ 网页接口（qun.qq.com 等）共用的请求方法
 *
 * 群星级、群荣誉、打卡、发言榜、群公告、幸运字符这些数据只能用 QQ 账号的网页登录凭据（cookies）去查，
 * 官方机器人没有 QQ 账号，一律交给同群的野生号：ICQQ 自带 cookies，OneBotv11 通过 get_cookies 获取。
 * 以 _ 开头，不会被当成工具登记。
 */

const TIMEOUT = 15000
const UA = 'Mozilla/5.0 (Linux; Android 12; M2012K11AC Build/SKQ1.220303.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Version/4.0 Chrome/89.0.4389.72 MQQBrowser/6.2 TBS/046141 Mobile Safari/537.36 QQ/8.9.28.10155 NetType/WIFI'

/** skey / p_skey 换成接口要的 bkn / g_tk */
export function hash (key = '') {
  let h = 5381
  for (let i = 0; i < key.length; i++) h += (h << 5) + key.charCodeAt(i)
  return h & 2147483647
}

const cookieValue = (cookie, name) => cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1] || ''

/** get_cookies 的几种返回格式：字符串、{ cookies }、{ data: { cookies } } */
const cookiesOf = ret => (typeof ret === 'string' ? ret : ret?.cookies || ret?.data?.cookies || (typeof ret?.data === 'string' ? ret.data : ''))

/**
 * 野生号在某个域名下的登录凭据
 * @returns {Promise<{ cookie: string, bkn: number, gtk: number, uin: string }>}
 */
export async function credentials (bot, domain = 'qun.qq.com') {
  let cookie = bot?.cookies?.[domain] || ''
  if (!cookie && typeof bot?.getCookies === 'function') cookie = cookiesOf(await bot.getCookies(domain).catch(() => ''))
  if (!cookie && typeof bot?.sendApi === 'function') cookie = cookiesOf(await bot.sendApi('get_cookies', { domain }).catch(() => ''))
  if (!cookie) throw new Error(`野生号拿不到 ${domain} 的登录凭据（协议端不支持 get_cookies）`)
  const skey = cookieValue(cookie, 'skey')
  const pskey = cookieValue(cookie, 'p_skey')
  return {
    cookie,
    bkn: Number(bot.bkn) || hash(skey || pskey),
    gtk: hash(pskey || skey),
    uin: String(bot.uin || bot.self_id || '').replace(/^o0*/, '')
  }
}

/** 请求网页接口，返回解析好的 JSON；返回的不是 JSON（多半是跳转到登录页）时报凭据失效 */
export async function request (url, { cookie, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'User-Agent': UA,
      Cookie: cookie,
      ...(body ? { 'Content-Type': 'application/json;charset=UTF-8' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT)
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    if (!res.ok) throw new Error(`接口返回 HTTP ${res.status}`)
    throw new Error('接口没有返回数据，野生号的网页登录凭据可能已失效')
  }
}

/** 接口返回的错误码；成功时返回空串 */
export function failure (ret) {
  const code = ret?.retcode ?? ret?.ec ?? ret?.retCode ?? ret?.code ?? 0
  if (Number(code) === 0) return ''
  const msg = ret?.msg || ret?.em || ret?.message || ret?.wording || ''
  return `${msg || '接口返回错误，可能是登录凭据失效或没有权限'}（错误码 ${code}）`
}

/** 请求并检查错误码，有错误时抛出 */
export async function call (url, options) {
  const ret = await request(url, options)
  const error = failure(ret)
  if (error) throw new Error(error)
  return ret
}

/** 群荣誉网页里的数据（window.__INITIAL_STATE__） */
export async function honorPage (cred, groupId, type) {
  const res = await fetch(`https://qun.qq.com/interactive/honorlist?gc=${groupId}&type=${type}&_wv=3&_wwv=129`, {
    headers: { 'User-Agent': UA, Cookie: cred.cookie },
    signal: AbortSignal.timeout(TIMEOUT)
  })
  const state = initialState(await res.text())
  if (!state) throw new Error('没有读到群荣誉数据，野生号的网页登录凭据可能已失效')
  return state
}

/** 网页里 window.__INITIAL_STATE__ = {...} 的对象：按括号配对截出完整的 JSON（跳过字符串里的括号） */
export function initialState (html) {
  const at = html.indexOf('__INITIAL_STATE__')
  const start = at < 0 ? -1 : html.indexOf('{', at)
  if (start < 0) return null
  let depth = 0
  let quote = ''
  for (let i = start; i < html.length; i++) {
    const c = html[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '{') {
      depth++
    } else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

/** 网页文字里的 HTML 实体 */
export const unescape = text => String(text ?? '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
