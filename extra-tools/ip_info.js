import net from 'node:net'
import { CustomTool } from 'chaite'

const TIMEOUT = 10000

/** 内网、本机等查不到归属地的地址 */
function isPrivate (ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  return /^(::1?|f[cd]|fe[89ab])/i.test(ip)
}

const isDomain = s => /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(s)

/** ip-api.com（中文结果，免费版只能用 http） */
async function ipApi (target) {
  const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(target)}?lang=zh-CN&fields=status,message,query,country,regionName,city,isp,org,as,timezone,mobile,proxy,hosting`, { signal: AbortSignal.timeout(TIMEOUT) })
  const d = await res.json()
  if (d.status !== 'success') throw new Error(d.message === 'invalid query' ? '不是有效的 IP 或域名' : d.message || '查询失败')
  const place = [d.country, d.regionName, d.city].filter((v, i, a) => v && a.indexOf(v) === i).join(' ')
  const tags = [d.mobile && '移动网络', d.proxy && '代理 / VPN', d.hosting && '机房 / 云服务器'].filter(Boolean)
  return [
    `IP：${d.query}`,
    place && `归属地：${place}`,
    d.isp && `运营商：${d.isp}`,
    d.org && d.org !== d.isp && `组织：${d.org}`,
    d.as && `AS：${d.as}`,
    d.timezone && `时区：${d.timezone}`,
    tags.length && `类型：${tags.join('、')}`
  ].filter(Boolean).join('\n')
}

/** 备用：ipinfo.io（英文结果） */
async function ipinfo (target) {
  const res = await fetch(`https://ipinfo.io/${target ? `${encodeURIComponent(target)}/` : ''}json`, { signal: AbortSignal.timeout(TIMEOUT) })
  const d = await res.json()
  if (!d.ip || d.bogon) throw new Error(d.error?.message || '查询失败')
  return [`IP：${d.ip}`, `归属地：${[d.country, d.region, d.city].filter(Boolean).join(' ')}`, d.org && `运营商：${d.org}`, d.timezone && `时区：${d.timezone}`]
    .filter(Boolean).join('\n')
}

export class IpInfoTool extends CustomTool {
  name = 'ip_info'

  function = {
    name: 'ip_info',
    description: '查询 IP 地址或域名的归属地、运营商、时区，以及是否为代理 / 机房 IP。不填 ip 为查询机器人服务器自己的公网 IP（仅主人）。',
    parameters: {
      type: 'object',
      properties: {
        ip: {
          type: 'string',
          description: 'IPv4 / IPv6 地址或域名，如 8.8.8.8、github.com'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    // 网址只取域名部分
    const raw = String(args.ip ?? '').trim()
    const target = net.isIP(raw) ? raw : raw.replace(/^https?:\/\//i, '').split(/[/:?#]/)[0]
    if (!target) {
      // 服务器的公网 IP 不能随便告诉群友
      if (!e?.isMaster) return '只有主人可以查询机器人服务器的 IP，请提供要查的 IP 或域名'
    } else if (!net.isIP(target) && !isDomain(target)) {
      return `“${args.ip}”不是有效的 IP 地址或域名`
    } else if (net.isIP(target) && isPrivate(target)) {
      return `${target} 是内网 / 本机地址，没有公网归属地`
    }
    const errors = []
    for (const fn of [ipApi, ipinfo]) {
      try {
        return await fn(target)
      } catch (err) {
        errors.push(err?.name === 'TimeoutError' ? '请求超时' : err.message)
        if (errors[0] === '不是有效的 IP 或域名') break
      }
    }
    return `查询失败：${errors.join('；')}`
  }
}

export default new IpInfoTool()
