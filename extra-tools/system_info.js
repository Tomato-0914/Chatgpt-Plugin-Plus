import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Chaite, CustomTool } from 'chaite'

const TOOLS_DIR = path.resolve('./plugins/chatgpt-plugin/extra-tools')
const ADAPTERS = { QQBot: '官方机器人', OneBotv11: 'OneBot', ICQQ: 'ICQQ' }
const { redact } = await import(pathToFileURL(path.join(TOOLS_DIR, '_redact.js')).href)

/** 协议端接口最多等几秒，免得一个掉线的账号卡住整个查询 */
async function api (bot, action, params = {}) {
  if (typeof bot?.sendApi !== 'function') return null
  const ret = await Promise.race([bot.sendApi(action, params), new Promise(resolve => setTimeout(() => resolve(null), 5000))]).catch(() => null)
  return ret?.data ?? ret
}

const isOtherProtocol = bot => ['OneBotv11', 'ICQQ'].includes(bot?.adapter?.name)
const allBots = () => [...new Set((globalThis.Bot?.uin || []).map(id => globalThis.Bot[id]))].filter(Boolean)

/** 每个机器人账号的详情：类型、协议端和版本、在线状态、收发统计、好友 / 群数量 */
async function botDetails (e) {
  const bots = allBots()
  if (!bots.length) return '没有在线的机器人账号'
  const blocks = []
  for (const bot of bots) {
    const name = bot.nickname || bot.info?.nickname || bot.info?.username || ''
    const kind = bot.adapter?.id === 'QQBot' ? 'QQ 官方机器人' : isOtherProtocol(bot) ? `其他协议机器人（${bot.adapter.name}，用 QQ 号登录）` : bot.adapter?.name || '未知'
    const lines = [`${name}（${bot.uin}）${bot === e?.bot ? '【当前】' : ''}：${kind}`]
    if (bot.adapter?.id === 'QQBot' && bot.info?.appid) lines.push(`  AppID：${bot.info.appid}`)
    // 协议端：TRSS 的适配器把实现名和版本放在 bot.version；OneBot 再问 get_version_info
    const ver = await api(bot, 'get_version_info')
    const impl = ver?.app_name ? `${ver.app_name} ${ver.app_version || ''}${ver.protocol_version ? `（${ver.protocol_version}）` : ''}` : bot.version?.name ? `${bot.version.name} ${bot.version.version || ''}` : bot.apk?.name ? `${bot.apk.name} ${bot.apk.version || ''}` : ''
    if (impl) lines.push(`  协议端：${impl.trim()}`)
    const status = await api(bot, 'get_status')
    const online = status ? (status.online === false ? '离线' : status.good === false ? '在线但状态异常' : '在线') : typeof bot.isOnline === 'function' ? (bot.isOnline() ? '在线' : '离线') : '在线'
    const since = bot.stat?.start_time ? `，已登录 ${duration(Date.now() / 1000 - bot.stat.start_time)}` : ''
    lines.push(`  状态：${online}${since}`)
    const st = status?.stat || bot.stat || {}
    const recv = st.message_received ?? st.recv_msg_cnt
    const sent = st.message_sent ?? st.sent_msg_cnt
    if (recv !== undefined || sent !== undefined) lines.push(`  消息：收到 ${recv ?? '?'} 条，发出 ${sent ?? '?'} 条${st.lost_times !== undefined ? `，掉线 ${st.lost_times} 次` : ''}`)
    lines.push(`  ${count(bot.gl)} 个群、${count(bot.fl)} 个好友`)
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n')
}

/** 其他协议机器人账号同时登录的设备（手机、电脑等） */
async function onlineClients () {
  const bots = allBots().filter(isOtherProtocol)
  if (!bots.length) return '没有其他协议机器人账号（官方机器人没有在线设备的概念）'
  const lines = []
  for (const bot of bots) {
    let list = null
    const ret = await api(bot, 'get_online_clients', { no_cache: true })
    if (ret) list = ret.clients || ret
    else if (typeof bot.getOnlineClients === 'function') list = await bot.getOnlineClients().catch(() => null)
    const name = `${bot.nickname || ''}（${bot.uin}）`
    if (!Array.isArray(list)) lines.push(`${name}：协议端不支持查询在线设备`)
    else if (!list.length) lines.push(`${name}：没有其他设备在线`)
    else lines.push(`${name}：${list.map(c => [c.device_name, c.device_kind].filter(Boolean).join(' / ') || String(c.app_id || '未知设备')).join('；')}`)
  }
  return lines.join('\n')
}

/** 名字像密钥的环境变量：值整个打码 */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|PWD|COOKIE|AUTH|CREDENTIAL|SESSION|PRIVATE|SIGN|DSN|DATABASE_URL|_URI$|_URL$/i

/** 环境变量（仅主人）：按名字或正则筛选，密钥一律打码 */
function envVars (e, name, pattern) {
  if (!e?.isMaster) return '只有主人可以查看环境变量'
  let entries = Object.entries(process.env)
  if (name) entries = entries.filter(([k]) => k === name || k.toLowerCase() === String(name).toLowerCase())
  if (pattern) {
    let re
    try { re = new RegExp(pattern, 'i') } catch { return `正则写错了：${pattern}` }
    entries = entries.filter(([k]) => re.test(k))
  }
  if (!entries.length) return name ? `没有环境变量 ${name}` : '没有符合条件的环境变量'
  entries.sort(([a], [b]) => a.localeCompare(b))
  const shown = entries.slice(0, 100).map(([k, v]) => `${k}=${SECRET_NAME.test(k) ? '***' : redact(String(v)).slice(0, 200)}`)
  return `环境变量（${entries.length} 个${entries.length > 100 ? '，只列前 100 个' : ''}，名字像密钥的整个打码）：\n${shown.join('\n')}`
}

const mb = n => `${Math.round(n / 1024 / 1024)}MB`
const gb = n => `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`

function duration (seconds) {
  const s = Math.floor(seconds)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${d ? `${d}天` : ''}${d || h ? `${h}小时` : ''}${m}分钟`
}

function version (file) {
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
    return `${pkg.name || ''} ${pkg.version || ''}`.trim()
  } catch {
    return ''
  }
}

const count = map => (map instanceof Map ? map.size : map && typeof map === 'object' ? Object.keys(map).length : 0)

function environment (e) {
  const mem = process.memoryUsage()
  const cpus = os.cpus()
  const lines = [
    `框架：${version(path.resolve('package.json')) || 'Yunzai'}，插件：${version(path.join(TOOLS_DIR, '..', 'package.json')) || 'chatgpt-plugin'}`,
    `Node.js：${process.version}，系统：${os.type()} ${os.release()}（${process.arch}）`,
    `已运行：${duration(process.uptime())}（服务器开机 ${duration(os.uptime())}）`,
    `内存：本进程 ${mb(mem.rss)}，系统已用 ${gb(os.totalmem() - os.freemem())} / ${gb(os.totalmem())}`,
    cpus.length ? `CPU：${cpus[0].model.trim()} × ${cpus.length}${process.platform !== 'win32' ? `，负载 ${os.loadavg().map(n => n.toFixed(2)).join(' / ')}` : ''}` : ''
  ]
  const bots = (globalThis.Bot?.uin || []).map(id => globalThis.Bot[id]).filter(Boolean)
  if (bots.length) {
    lines.push(`在线账号（${bots.length} 个）：`)
    for (const bot of bots) {
      const name = bot.nickname || bot.info?.nickname || ''
      lines.push(`- ${name}（${bot.uin}）${ADAPTERS[bot.adapter?.name] || bot.adapter?.name || ''}，${count(bot.gl)} 个群、${count(bot.fl)} 个好友` +
        `${bot.stat?.start_time ? `，在线 ${duration(Date.now() / 1000 - bot.stat.start_time)}` : ''}${bot === e?.bot ? '（当前）' : ''}`)
    }
  }
  if (e) lines.push(`当前会话：${e.isGroup || e.group_id ? `群聊 ${e.group_id}` : '私聊'}，发言人 ${e.user_id}${e.isMaster ? '（主人）' : ''}`)
  return lines.filter(Boolean).join('\n')
}

/** 取代码里 name = 'xxx' 的名字（与同步工具的规则一致） */
const codeName = code => /class\s+\w+\s+extends\s+\w+\s+{[\s\S]*?name\s*=\s*['"]([^'"]+)['"]/.exec(code)?.[1]

/** 扩展工具目录里的工具的参数定义 */
async function extraParameters (name) {
  for (const file of fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith('.js') && !f.startsWith('_'))) {
    const full = path.join(TOOLS_DIR, file)
    if (codeName(fs.readFileSync(full, 'utf8')) !== name) continue
    const mod = await import(pathToFileURL(full).href)
    return mod.default?.function?.parameters || null
  }
  return null
}

function formatParameters (params) {
  const props = Object.entries(params?.properties || {})
  if (!props.length) return '参数：无'
  const required = new Set(params.required || [])
  return ['参数：', ...props.map(([key, p]) =>
    `- ${key}（${p.type || 'any'}${required.has(key) ? '，必填' : ''}）${p.description || ''}${p.enum ? ` 可选值：${p.enum.join(' / ')}` : ''}`)].join('\n')
}

async function tools () {
  const manager = Chaite.getInstance?.()?.getToolsManager?.()
  if (!manager) throw new Error('chaite 还没有初始化')
  return await manager.listInstances()
}

async function toolInfo (name) {
  const all = await tools()
  const tool = all.find(t => t.name === name) || all.find(t => t.name.toLowerCase() === name.toLowerCase())
  if (!tool) {
    const similar = all.filter(t => t.name.includes(name) || name.includes(t.name)).map(t => t.name)
    return `没有叫 ${name} 的工具${similar.length ? `，相近的有：${similar.join('、')}` : ''}`
  }
  const groups = await Chaite.getInstance().getToolsGroupManager?.()?.listInstances?.().catch(() => []) || []
  const inGroups = groups.filter(g => (g.toolIds || []).includes(tool.id)).map(g => g.name)
  const params = await extraParameters(tool.name).catch(() => null)
  return [
    `工具：${tool.name}${tool.status && tool.status !== 'enabled' ? `（${tool.status === 'disabled' ? '已停用' : tool.status}）` : ''}`,
    `说明：${tool.description || '无'}`,
    inGroups.length ? `所在工具组：${inGroups.join('、')}` : '',
    params ? formatParameters(params) : '参数：这个工具不在扩展工具目录里，查不到参数定义'
  ].filter(Boolean).join('\n')
}

async function toolList (keyword) {
  const kw = String(keyword ?? '').trim().toLowerCase()
  const list = (await tools()).filter(t => !kw || t.name.toLowerCase().includes(kw) || String(t.description || '').toLowerCase().includes(kw))
  if (!list.length) return kw ? `没有名字或说明包含“${keyword}”的工具` : '工具库里还没有工具'
  const short = d => String(d || '').split(/[。；\n]/)[0].slice(0, 50)
  return `${kw ? `找到 ${list.length} 个工具` : `工具库里共 ${list.length} 个工具`}：\n${list.map(t => `- ${t.name}：${short(t.description)}`).join('\n')}`
}

export class SystemInfoTool extends CustomTool {
  name = 'system_info'

  function = {
    name: 'system_info',
    description: '查询机器人自身的情况：运行环境，包括框架和插件版本、Node.js、系统、运行时间、内存、在线账号（env）；' +
      '每个机器人账号的详情：类型、协议端和版本、在线状态、收发消息统计、好友和群数量（bots）；其他协议机器人账号同时登录的设备（clients）；' +
      '环境变量（env_vars，仅主人，密钥打码）；工具库里的工具列表（tools，可按关键词筛选）；某个工具的说明和参数（tool）。' +
      '用户问“你运行在什么环境”“你是什么版本”“你在线吗”“你有哪些工具”“xx 工具怎么用”时调用。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['env', 'bots', 'clients', 'env_vars', 'tools', 'tool'],
          description: 'env=运行环境（默认）；bots=机器人账号详情；clients=在线设备；env_vars=环境变量（仅主人）；tools=工具列表；tool=某个工具的详细信息'
        },
        tool_name: {
          type: 'string',
          description: 'action=tool 时的工具名'
        },
        keyword: {
          type: 'string',
          description: 'action=tools 时按名字或说明筛选'
        },
        env_name: {
          type: 'string',
          description: 'action=env_vars 时只看这一个环境变量'
        },
        env_pattern: {
          type: 'string',
          description: 'action=env_vars 时按名字筛选的正则，如 ^NODE'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    try {
      if (args.action === 'tool') {
        const name = String(args.tool_name ?? '').trim()
        return name ? await toolInfo(name) : '请提供工具名'
      }
      if (args.action === 'tools') return await toolList(args.keyword)
      const e = context?.getEvent?.()
      if (args.action === 'bots') return await botDetails(e)
      if (args.action === 'clients') return await onlineClients()
      if (args.action === 'env_vars') return envVars(e, String(args.env_name ?? '').trim(), String(args.env_pattern ?? '').trim())
      return environment(e)
    } catch (err) {
      return `查询失败：${err?.message || err}`
    }
  }
}

export default new SystemInfoTool()
