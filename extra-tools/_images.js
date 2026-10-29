/**
 * 图片类工具共用：把几张图片放进一条消息发到当前聊天
 * 以 _ 开头，不会被当成工具登记。
 */

/** 洗牌后取前 n 个 */
export function pick (list, n) {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

/** 发送图片，返回给 AI 的结果文字 */
export async function sendImages (e, urls, text = '') {
  if (typeof e?.reply !== 'function') return '当前没有可用的聊天，无法发送图片'
  const msg = urls.map(file => ({ type: 'image', file }))
  if (text) msg.push(String(text))
  try {
    const ret = await e.reply(msg)
    const ok = Array.isArray(ret?.message_id) ? ret.message_id.length > 0 : ret?.message_id != null
    if (!ok) return `图片发送失败：${ret?.error?.[0]?.message || '没有返回消息 ID'}`
    return `已发送 ${urls.length} 张图片，不需要再描述图片或贴出链接`
  } catch (err) {
    return `图片发送失败：${err.message}`
  }
}
