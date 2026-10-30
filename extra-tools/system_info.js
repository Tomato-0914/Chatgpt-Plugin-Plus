import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Chaite, CustomTool } from 'chaite'

const TOOLS_DIR = path.resolve('./plugins/chatgpt-plugin/extra-tools')
const ADAPTERS = { QQBot: '官方机器人', OneBotv11: 'OneBot', ICQQ: 'ICQQ' }

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
      '工具库里的工具列表（tools，可按关键词筛选）；某个工具的说明和参数（tool）。用户问“你运行在什么环境”“你有哪些工具”“xx 工具怎么用”时调用。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['env', 'tools', 'tool'],
          description: 'env=运行环境（默认）；tools=工具列表；tool=某个工具的详细信息'
        },
        tool_name: {
          type: 'string',
          description: 'action=tool 时的工具名'
        },
        keyword: {
          type: 'string',
          description: 'action=tools 时按名字或说明筛选'
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
      return environment(context?.getEvent?.())
    } catch (err) {
      return `查询失败：${err?.message || err}`
    }
  }
}

export default new SystemInfoTool()
