import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { Chaite } from 'chaite'
import ChatGPTConfig from '../config/config.js'

/**
 * 扩展工具、扩展处理器同步
 *
 * extra-tools/ 下每个 .js 是一个 chaite 工具（CustomTool），extra-processors/ 下每个 .js 是一个处理器
 * （PreProcessor / PostProcessor）。chaite 只使用在数据库里登记过的工具和处理器，直接把文件放进
 * utils/tools、utils/processors 不会生效，所以这里把它们登记进去（同时写入对应目录）：
 *   - 工具全部放进“扩展工具”工具组，在面板的预设里勾选这个工具组即可使用
 *   - 处理器在面板的预设里勾选对应的前置 / 后置处理器即可使用
 * 启动时自动同步一次（代码有变化才更新），也可以发送 #chatgpt同步工具 手动同步。
 * 修改请改 extra-tools / extra-processors 里的文件，在面板里改的代码会在下次同步时被覆盖。
 * 以 _ 开头的文件是共用的辅助模块，不登记。
 */
const PLUGIN_DIR = path.resolve('./plugins/chatgpt-plugin')
const TOOLS_DIR = path.join(PLUGIN_DIR, 'extra-tools')
const PROCESSORS_DIR = path.join(PLUGIN_DIR, 'extra-processors')
const GROUP_NAME = '扩展工具'
/** 主人确认 / 拒绝风险操作：#确认、#拒绝、yes / no、Y / N，按钮回调后面带申请编号 */
const APPROVE_REG = /^(#确认|#拒绝|#?yes|#?no|#?y|#?n)(?:\s+([0-9a-f]{6}))?$/i

/** 取代码里 name = 'xxx' 的名字（与 chaite 的 extractClassName 规则一致） */
function codeName (code) {
  return /class\s+\w+\s+extends\s+\w+\s+{[\s\S]*?name\s*=\s*['"]([^'"]+)['"]/.exec(code)?.[1]
}

/** 取第一个 description 作为描述 */
function codeDescription (code) {
  return /description\s*[:=]\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(code)?.[2] || ''
}

/** 处理器类型：代码里 type = 'pre' / 'post' */
function processorType (code) {
  return /\btype\s*=\s*['"](pre|post)['"]/.exec(code)?.[1]
}

const hash = code => crypto.createHash('md5').update(code).digest('hex')

/**
 * 把目录里的代码登记进 manager
 * @param {string} dir
 * @param {*} manager - chaite 的 ToolManager / ProcessorsManager
 * @param {(code: string) => object|string} fields - 额外字段；返回字符串表示不能登记的原因
 */
async function syncDir (dir, manager, fields) {
  const result = { added: [], updated: [], unchanged: [], failed: [], ids: [] }
  if (!fs.existsSync(dir)) return result
  const existing = await manager.listInstances()
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('_')).sort()) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8')
    const name = codeName(code)
    const extra = name ? fields(code) : `没有找到 name = '名字'`
    if (typeof extra === 'string') {
      result.failed.push(`${file}（${extra}）`)
      continue
    }
    try {
      const old = existing.find(t => t.name === name)
      // 代码没变就不重写，避免每次启动都触发 chaite 的文件监听重新扫描
      if (old && old.code && hash(old.code) === hash(code)) {
        result.unchanged.push(name)
        result.ids.push(old.id)
        continue
      }
      const id = await manager.addInstance({
        ...(old ? { id: old.id, createdAt: old.createdAt } : { createdAt: new Date().toISOString() }),
        name,
        description: codeDescription(code),
        code,
        modelType: 'executable',
        ...extra,
        updatedAt: new Date().toISOString()
      })
      result.ids.push(id)
      result[old ? 'updated' : 'added'].push(name)
    } catch (err) {
      result.failed.push(`${name}（${err.message}）`)
    }
  }
  return result
}

async function syncExtraTools () {
  const chaite = Chaite.getInstance()
  const toolsManager = chaite?.getToolsManager?.()
  const groupManager = chaite?.getToolsGroupManager?.()
  const processorsManager = chaite?.getProcessorsManager?.()
  if (!toolsManager || !groupManager) throw new Error('chaite 尚未初始化')

  const tools = await syncDir(TOOLS_DIR, toolsManager, () => ({ permission: 'private', status: 'enabled' }))
  if (tools.ids.length) {
    const groups = await groupManager.listInstances()
    const group = groups.find(g => g.name === GROUP_NAME)
    const toolIds = [...new Set([...(group?.toolIds || []), ...tools.ids])]
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

  const processors = processorsManager
    ? await syncDir(PROCESSORS_DIR, processorsManager, code => {
      const type = processorType(code)
      return type ? { type } : "没有找到 type = 'pre' 或 'post'"
    })
    : { added: [], updated: [], unchanged: [], failed: [], ids: [] }
  return { tools, processors }
}

function summary ({ tools, processors }) {
  const parts = []
  for (const [label, r] of [['工具', tools], ['处理器', processors]]) {
    if (r.added.length) parts.push(`新增${label}：${r.added.join('、')}`)
    if (r.updated.length) parts.push(`更新${label}：${r.updated.join('、')}`)
    if (r.unchanged.length) parts.push(`${label}无变化：${r.unchanged.join('、')}`)
    if (r.failed.length) parts.push(`${label}失败：${r.failed.join('、')}`)
  }
  return parts.join('\n') || '没有需要同步的工具或处理器'
}

const changed = ({ tools, processors }) =>
  [tools, processors].some(r => r.added.length || r.updated.length || r.failed.length)

// 启动提醒的定时检查（extra-tools/_reminders.js），重启前设置的提醒继续有效
import(pathToFileURL(path.join(TOOLS_DIR, '_reminders.js')).href)
  .then(reminders => reminders.start())
  .catch(err => logger.error('[扩展工具] 提醒启动失败', err))

// 启动时等 chaite 初始化完成后同步一次
;(async () => {
  for (let i = 0; i < 60; i++) {
    if (Chaite.getInstance()?.getToolsManager?.()) {
      try {
        const r = await syncExtraTools()
        if (changed(r)) logger.mark(`[扩展工具] ${summary(r).replace(/\n/g, '；')}`)
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
      dsc: '同步 extra-tools、extra-processors 目录中的工具和处理器',
      event: 'message',
      priority: 20,
      rule: [
        {
          reg: `^${ChatGPTConfig.basic.commandPrefix}同步工具$`,
          fnc: 'sync',
          permission: 'master'
        },
        {
          // 风险工具（群管、shell 等）由非主人发起时，主人用这个确认或拒绝；按钮回调会带上申请编号。
          // 不设 permission：群友随口说 “y” 时不能回 “暂无权限”，非主人或没有待确认的申请时直接放行
          reg: APPROVE_REG,
          fnc: 'approve'
        }
      ]
    })
  }

  async approve (e) {
    if (!e.isMaster) return false
    const [, word, id] = String(e.msg || '').trim().match(APPROVE_REG) || []
    if (!word) return false
    const approval = await import(pathToFileURL(path.join(TOOLS_DIR, '_approval.js')).href)
    const text = await approval.decide(e, /^(#确认|#?yes|#?y)$/i.test(word), id)
    if (text === null) return false
    await e.reply(text)
    return true
  }

  async sync (e) {
    try {
      const r = await syncExtraTools()
      await e.reply(`扩展工具同步完成\n${summary(r)}\n\n在面板的预设里勾选工具组「${GROUP_NAME}」和需要的处理器即可使用`)
    } catch (err) {
      await e.reply(`扩展工具同步失败：${err.message}`)
    }
    return true
  }
}
