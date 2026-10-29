/**
 * 60s API（开源项目 vikiboss/60s 的公共实例）请求封装：结果缓存 5 分钟，被限流时等 2 秒重试一次
 * 以 _ 开头，不会被当成工具登记。
 */
const API = 'https://60s.viki.moe/v2'
const TTL = 5 * 60 * 1000

const cache = (globalThis[Symbol.for('chatgpt-extra-tools-60s')] ??= new Map())

export async function fetch60s (path) {
  const hit = cache.get(path)
  if (hit && hit.expiresAt > Date.now()) return hit.data
  const send = () => fetch(`${API}${path}`, { signal: AbortSignal.timeout(10000) })
  let res = await send()
  if (res.status === 429) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    res = await send()
  }
  if (res.status === 429) throw new Error('请求太频繁，请稍后再试')
  let body
  try {
    body = JSON.parse(await res.text())
  } catch {
    throw new Error(`接口返回异常（HTTP ${res.status}）`)
  }
  if (body.code !== 200) throw new Error(body.message || `接口返回错误（HTTP ${res.status}）`)
  for (const [key, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(key)
  cache.set(path, { data: body.data, expiresAt: Date.now() + TTL })
  return body.data
}

/** 热度数字排成「250.4万」 */
export function formatHot (value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return ''
  return num >= 10000 ? `${(num / 10000).toFixed(1)}万` : String(num)
}

export const errorText = err => (err?.name === 'TimeoutError' ? '请求超时' : err?.message || String(err))
