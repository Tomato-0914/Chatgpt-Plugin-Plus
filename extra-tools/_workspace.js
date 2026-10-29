/**
 * 文件工具共用的目录与权限
 *
 * 两个根目录（工具参数 root）：
 *   workspace  AI 专用的工作目录 plugins/chatgpt-plugin/data/files，所有人可用
 *   yunzai     整个 Yunzai 框架目录，只有主人可用：
 *                - 查看的内容会打码（_redact.js），密钥不会出现在 AI 面前
 *                - 修改前自动备份到 data/backups，可以用 file_restore 还原
 *                - 不能写入带 *** 的内容，含密钥的文件不能整体覆盖（避免把打码后的内容写回去，弄丢真实密钥）
 *                - 框架里的文件只能在私聊里发送
 *              .git、node_modules 无论谁都不能访问
 * 路径一律相对根目录，不能用 .. 或软链接跳出去。以 _ 开头，不会被当成工具登记。
 */
import fs from 'node:fs'
import path from 'node:path'

export const ROOT = path.resolve('./plugins/chatgpt-plugin/data/files')
export const YUNZAI_ROOT = path.resolve('.')
export const BACKUP_ROOT = path.resolve('./plugins/chatgpt-plugin/data/backups')

/** 框架目录里谁都不能访问的目录 */
const BLOCKED = new Set(['.git', 'node_modules'])

/** 单个文件读取、写入、下载的大小上限 */
export const LIMITS = {
  read: 200 * 1024,
  write: 1024 * 1024,
  download: 50 * 1024 * 1024
}

/** 工具参数里的 root 定义，各文件工具共用 */
export const ROOT_PARAM = {
  type: 'string',
  enum: ['workspace', 'yunzai'],
  description: 'workspace=AI 工作目录（默认）；yunzai=整个 Yunzai 框架目录，只有主人能用，查看时密钥会打码，修改前自动备份'
}

export const WORKSPACE = { base: ROOT, yunzai: false }
const FRAMEWORK = { base: YUNZAI_ROOT, yunzai: true }

/** 按工具参数选根目录；非主人要访问框架目录时抛错 */
export function scope (e, root) {
  if (root !== 'yunzai') return WORKSPACE
  if (!e?.isMaster) throw new Error('只有主人可以访问框架目录，其他人只能用工作目录')
  return FRAMEWORK
}

function inside (root, target) {
  return target === root || target.startsWith(root + path.sep)
}

/** 最近一个存在的上级目录的真实路径，用于检查软链接是否跳出根目录 */
function realExisting (target) {
  let current = target
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.join(fs.realpathSync(current), path.relative(current, target))
}

/** 相对根目录的路径转成绝对路径，跳出根目录或访问被屏蔽的目录时抛错 */
export function resolvePath (p = '.', s = WORKSPACE) {
  if (s === WORKSPACE) fs.mkdirSync(ROOT, { recursive: true })
  const rel = String(p ?? '.').trim().replace(/\\/g, '/').replace(/^\/+/, '') || '.'
  const full = path.resolve(s.base, rel)
  if (!inside(s.base, full) || !inside(fs.realpathSync(s.base), realExisting(full))) {
    throw new Error(`只能访问${s.yunzai ? '框架' : '工作'}目录内的文件，路径请写成相对路径，如 ${s.yunzai ? 'plugins/xxx/config.yaml' : 'notes/todo.txt'}`)
  }
  if (path.relative(s.base, full).split(path.sep).some(part => BLOCKED.has(part))) {
    throw new Error('.git、node_modules 目录不能访问')
  }
  return full
}

/** 绝对路径转成显示用的相对路径 */
export const display = (full, s = WORKSPACE) => path.relative(s.base, full).replace(/\\/g, '/') || '.'

/** 是否为被屏蔽的目录名（列目录时隐藏） */
export const isBlocked = name => BLOCKED.has(name)

/** 修改框架文件前备份原文件，返回备份的相对路径（文件不存在时返回空） */
export function backup (full) {
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return ''
  const now = new Date()
  const stamp = `${now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/[-: ]/g, '').replace(/^(\d{8})/, '$1-')}-${String(now.getMilliseconds()).padStart(3, '0')}`
  const target = path.join(BACKUP_ROOT, stamp, path.relative(YUNZAI_ROOT, full))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (!fs.existsSync(target)) fs.copyFileSync(full, target)
  return path.relative(YUNZAI_ROOT, target).replace(/\\/g, '/')
}

/** 某个框架文件的所有备份，从新到旧 */
export function backupsOf (full) {
  if (!fs.existsSync(BACKUP_ROOT)) return []
  const rel = path.relative(YUNZAI_ROOT, full)
  return fs.readdirSync(BACKUP_ROOT)
    .filter(stamp => fs.existsSync(path.join(BACKUP_ROOT, stamp, rel)))
    .sort()
    .reverse()
    .map(stamp => ({ stamp, file: path.join(BACKUP_ROOT, stamp, rel) }))
}

export function formatSize (n) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/** 粗略判断是否为二进制文件：前 8KB 里有 NUL 字节 */
export function isBinary (buffer) {
  return buffer.subarray(0, 8192).includes(0)
}

/** 工具出错时统一返回的文字 */
export const errorText = err => `操作失败：${err?.message || err}`
