import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Chaite } from 'chaite'
import ChatGPTConfig from '../config/config.js'

/**
 * 扩展工具同步
 *
 * extra-tools/ 下每个 .js 是一个 chaite 工具（CustomTool）。chaite 只使用在工具库（数据库）里登记过的工具，
 * 直接把文件放进 utils/tools 不会生效，所以这里把它们登记进工具库（同时写入 utils/tools），
 * 并全部放进“扩展工具”工具组；在面板的预设里勾选这个工具组即可使用。
 * 启动时自动同步一次（代码有变化才更新），也可以发送 #chatgpt同步工具 手动同步。
 * 修改工具请改 extra-tools 里的文件，在面板里改的代码会在下次同步时被覆盖。
 * 以 _ 开头的文件是工具共用的辅助模块，不登记为工具。
 */
const TOOLS_DIR = path.resolve('./plugins/chatgpt-plugin/extra-tools')
const GROUP_NAME = '扩展工具'

/** 取工具代码里 name = 'xxx' 的工具名（与 chaite 的 extractClassName 规则一致） */
function toolName (code) {
  return /class\s+\w+\s+extends\s+\w+\s+{[\s\S]*?name\s*=\s*['"]([^'"]+)['"]/.exec(code)?.[1]
}

/** 取 function.description 作为工具库里的描述 */
function toolDescription (code) {
  return /description:\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(code)?.[2] || ''
}

const hash = code => crypto.createHash('md5').update(code).digest('hex')

async function syncExtraTools () {
  const chaite = Chaite.getInstance()
  const toolsManager = chaite?.getToolsManager?.()
  const groupManager = chaite?.getToolsGroupManager?.()
  if (!toolsManager || !groupManager) throw new Error('chaite 尚未初始化')
  if (!fs.existsSync(TOOLS_DIR)) return { added: [], updated: [], unchanged: [], failed: [] }

  const result = { added: [], updated: [], unchanged: [], failed: [] }
  const existing = await toolsManager.listInstances()
  const ids = []
  for (const file of fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith('.js') && !f.startsWith('_')).sort()) {
    const code = fs.readFileSync(path.join(TOOLS_DIR, file), 'utf8')
    const name = toolName(code)
    if (!name) {
      result.failed.push(`${file}（没有找到 name = '工具名'）`)
      continue
    }
    try {
      const old = existing.find(t => t.name === name)
      const codeHash = hash(code)
      // 代码没变就不重写，避免每次启动都触发 chaite 的文件监听重新扫描
      if (old && old.code && hash(old.code) === codeHash) {
        result.unchanged.push(name)
        ids.push(old.id)
        continue
      }
      const id = await toolsManager.addInstance({
        ...(old ? { id: old.id, createdAt: old.createdAt } : { createdAt: new Date().toISOString() }),
        name,
        description: toolDescription(code),
        code,
        modelType: 'executable',
        permission: 'private',
        status: old?.status || 'enabled',
        updatedAt: new Date().toISOString()
      })
      ids.push(id)
      result[old ? 'updated' : 'added'].push(name)
    } catch (err) {
      result.failed.push(`${name}（${err.message}）`)
    }
  }

  if (ids.length) {
    const groups = await groupManager.listInstances()
    const group = groups.find(g => g.name === GROUP_NAME)
    const toolIds = [...new Set([...(group?.toolIds || []), ...ids])]
    if (!group || toolIds.length !== (group.toolIds || []).length) {
      await groupManager.addInstance({
        ...(group || { createdAt: new Date().toISOString() }),
        name: GROUP_NAME,
        description: '番茄维护的扩展工具（extra-tools 目录，自动同步）',
        modelType: 'settings',
        toolIds,
        updatedAt: new Date().toISOString()
      })
    }
  }
  return result
}

function summary (r) {
  const parts = []
  if (r.added.length) parts.push(`新增：${r.added.join('、')}`)
  if (r.updated.length) parts.push(`更新：${r.updated.join('、')}`)
  if (r.unchanged.length) parts.push(`无变化：${r.unchanged.join('、')}`)
  if (r.failed.length) parts.push(`失败：${r.failed.join('、')}`)
  return parts.join('\n') || 'extra-tools 目录里没有工具'
}

// 启动时等 chaite 初始化完成后同步一次
;(async () => {
  for (let i = 0; i < 60; i++) {
    if (Chaite.getInstance()?.getToolsManager?.()) {
      try {
        const r = await syncExtraTools()
        if (r.added.length || r.updated.length || r.failed.length) logger.mark(`[扩展工具] ${summary(r).replace(/\n/g, '；')}`)
      } catch (err) {
        logger.error('[扩展工具] 同步失败', err)
      }
      return
    }
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
  logger.warn('[扩展工具] 等待 chaite 初始化超时，未同步，可发送 #chatgpt同步工具 手动同步')
})()

export class ChatGPTExtraTools extends plugin {
  constructor () {
    super({
      name: 'ChatGPT-Plugin扩展工具',
      dsc: '同步 extra-tools 目录中的工具',
      event: 'message',
      priority: 20,
      rule: [
        {
          reg: `^${ChatGPTConfig.basic.commandPrefix}同步工具$`,
          fnc: 'sync',
          permission: 'master'
        }
      ]
    })
  }

  async sync (e) {
    try {
      const r = await syncExtraTools()
      await e.reply(`扩展工具同步完成\n${summary(r)}\n\n在面板的预设里勾选工具组「${GROUP_NAME}」即可使用`)
    } catch (err) {
      await e.reply(`扩展工具同步失败：${err.message}`)
    }
    return true
  }
}
