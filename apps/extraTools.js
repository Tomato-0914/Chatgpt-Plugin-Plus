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
 * extra-skills/ 下每个目录是一个技能（SKILL.md），复制到 chaite 的技能目录 data/skills（见 syncSkills）。
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

const loadApproval = () => import(pathToFileURL(path.join(TOOLS_DIR, '_approval.js')).href)

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
  const skills = await syncSkills()
  return { tools, processors, skills }
}

/* ---------- 技能 ---------- */

/**
 * 扩展技能同步：extra-skills/<目录>/SKILL.md 复制到 chaite 的技能目录（data/skills，被 gitignore）。
 * 记录文件 data/skills/.extra-skills.json 记着装进去的每个技能的内容摘要：
 *   - 没改过的：extra-skills 里有更新就覆盖，extra-skills 里删掉了就一起删
 *   - 在面板或文件里改过的：不再覆盖，归主人自己管
 *   - 删掉了的（不想用）：不再装回来；想恢复就把记录文件里对应的一行删掉再同步
 *   - data/skills 里本来就有同名目录（主人自己写的）：不动
 */
const SKILLS_DIR = path.join(PLUGIN_DIR, 'extra-skills')
const SKILLS_RECORD = '.extra-skills.json'

/** 目录里所有文件的相对路径（不含以 . 开头的） */
function filesOf (dir, base = '') {
  const out = []
  for (const entry of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const rel = path.join(base, entry.name)
    if (entry.isDirectory()) out.push(...filesOf(dir, rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out.sort()
}

/** 整个技能目录的摘要：文件路径 + 内容 */
function dirHash (dir) {
  const h = crypto.createHash('md5')
  for (const rel of filesOf(dir)) {
    h.update(rel.split(path.sep).join('/') + '\0')
    h.update(fs.readFileSync(path.join(dir, rel)))
    h.update('\0')
  }
  return h.digest('hex')
}

/** SKILL.md 里的 name，没有就用目录名 */
function skillName (dir, fallback) {
  try {
    return /^name:\s*['"]?(.+?)['"]?\s*$/m.exec(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'))?.[1] || fallback
  } catch {
    return fallback
  }
}

async function syncSkills () {
  const result = { added: [], updated: [], unchanged: [], failed: [], removed: [] }
  const registry = Chaite.getInstance()?.getSkillRegistry?.()
  if (!registry) return result
  const target = registry.getSkillsDir()
  fs.mkdirSync(target, { recursive: true })
  const recordFile = path.join(target, SKILLS_RECORD)
  let record = {}
  try {
    record = JSON.parse(fs.readFileSync(recordFile, 'utf8')) || {}
  } catch {}

  const sources = fs.existsSync(SKILLS_DIR)
    ? fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, d.name, 'SKILL.md')))
      .map(d => d.name).sort()
    : []
  for (const dir of sources) {
    const src = path.join(SKILLS_DIR, dir)
    const dst = path.join(target, dir)
    const name = skillName(src, dir)
    try {
      const srcHash = dirHash(src)
      const exists = fs.existsSync(dst)
      if (dir in record) {
        // 删掉了：主人不想用，不装回来
        if (!exists) continue
        // 改过了：归主人自己管
        if (dirHash(dst) !== record[dir]) {
          if (srcHash !== record[dir]) result.failed.push(`${name}（data/skills/${dir} 改过，不覆盖）`)
          continue
        }
        if (srcHash === record[dir]) {
          result.unchanged.push(name)
          continue
        }
      } else if (exists) {
        result.failed.push(`${name}（data/skills/${dir} 已有同名的技能，不覆盖）`)
        continue
      }
      fs.rmSync(dst, { recursive: true, force: true })
      fs.cpSync(src, dst, { recursive: true })
      record[dir] = srcHash
      result[exists ? 'updated' : 'added'].push(name)
    } catch (err) {
      result.failed.push(`${name}（${err.message}）`)
    }
  }
  // extra-skills 里删掉的技能：没改过的一起删掉
  for (const dir of Object.keys(record)) {
    if (sources.includes(dir)) continue
    const dst = path.join(target, dir)
    try {
      if (fs.existsSync(dst) && dirHash(dst) === record[dir]) {
        const name = skillName(dst, dir)
        fs.rmSync(dst, { recursive: true, force: true })
        result.removed.push(name)
      }
      delete record[dir]
    } catch (err) {
      result.failed.push(`${dir}（${err.message}）`)
    }
  }
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2))
  if (result.added.length || result.updated.length || result.removed.length) await registry.load()
  return result
}

function summary ({ tools, processors, skills }) {
  const parts = []
  for (const [label, r] of [['工具', tools], ['处理器', processors], ['技能', skills]]) {
    if (!r) continue
    if (r.added.length) parts.push(`新增${label}：${r.added.join('、')}`)
    if (r.updated.length) parts.push(`更新${label}：${r.updated.join('、')}`)
    if (r.removed?.length) parts.push(`删除${label}：${r.removed.join('、')}`)
    if (r.unchanged.length) parts.push(`${label}无变化：${r.unchanged.join('、')}`)
    if (r.failed.length) parts.push(`${label}未同步：${r.failed.join('、')}`)
  }
  return parts.join('\n') || '没有需要同步的工具、处理器或技能'
}

const changed = r =>
  [r.tools, r.processors, r.skills].some(x => x && (x.added.length || x.updated.length || x.removed?.length || x.failed.length))

// 启动提醒的定时检查（extra-tools/_reminders.js），重启前设置的提醒继续有效
import(pathToFileURL(path.join(TOOLS_DIR, '_reminders.js')).href)
  .then(reminders => reminders.start())
  .catch(err => logger.error('[扩展工具] 提醒启动失败', err))

// 启动时等 chaite 初始化完成后同步一次
;(async () => {
  for (let i = 0; i < 60; i++) {
    // 技能目录在 chaite 初始化的后段才挂上，一起等（老版本的 chaite 没有技能，等到工具就行）
    const chaite = Chaite.getInstance()
    if (chaite?.getToolsManager?.() && (chaite.getSkillRegistry?.() || typeof chaite.setSkillRegistry !== 'function' || i >= 12)) {
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
      dsc: '同步 extra-tools、extra-processors、extra-skills 目录中的工具、处理器和技能',
      event: 'message',
      priority: 20,
      rule: [
        {
          reg: `^${ChatGPTConfig.basic.commandPrefix}同步工具$`,
          fnc: 'sync',
          permission: 'master'
        },
        {
          // 风险工具由没有权限的人发起时，用这个确认或拒绝；按钮回调会带上申请编号。
          // 不设 permission：谁能处理由 _approval.js 判定（主人级只有主人，群管级还有本群群主、管理员），
          // 群友随口说 “y” 时不能回 “暂无权限”，没有权限或没有待确认的申请时直接放行
          reg: APPROVE_REG,
          fnc: 'approve'
        }
      ]
    })
  }

  /** 主人在官方机器人的群里说话时记下他在这个群的原始 openid（确认按钮里给主人单独一行用），不拦截消息 */
  accept (e) {
    if (e.isMaster && e.group_id && e.bot?.adapter?.id === 'QQBot') {
      loadApproval().then(a => a.rememberMaster(e)).catch(() => {})
    }
    return false
  }

  async approve (e) {
    const [, word, id] = String(e.msg || '').trim().match(APPROVE_REG) || []
    if (!word) return false
    const approval = await loadApproval()
    const text = await approval.decide(e, /^(#确认|#?yes|#?y)$/i.test(word), id)
    if (text === null) return false
    await e.reply(text)
    return true
  }

  async sync (e) {
    try {
      const r = await syncExtraTools()
      await e.reply(`扩展工具同步完成\n${summary(r)}\n\n在面板的预设里勾选工具组「${GROUP_NAME}」和需要的处理器即可使用；技能不用勾选，消息里出现它的关键词时自动启用`)
    } catch (err) {
      await e.reply(`扩展工具同步失败：${err.message}`)
    }
    return true
  }
}
