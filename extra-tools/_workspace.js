/**
 * 文件工具共用的工作目录
 *
 * AI 只能读写 plugins/chatgpt-plugin/data/files 里的文件，路径一律相对这个目录，
 * 不能用 .. 或软链接跳出去（拿不到配置文件、密钥等）。data 目录不受 git 管理，拉取更新不受影响。
 * 以 _ 开头，不会被当成工具登记。
 */
import fs from 'node:fs'
import path from 'node:path'

export const ROOT = path.resolve('./plugins/chatgpt-plugin/data/files')

/** 单个文件读取、写入、下载的大小上限 */
export const LIMITS = {
  read: 200 * 1024,
  write: 1024 * 1024,
  download: 50 * 1024 * 1024
}

function inside (root, target) {
  return target === root || target.startsWith(root + path.sep)
}

/** 最近一个存在的上级目录的真实路径，用于检查软链接是否跳出工作目录 */
function realExisting (target) {
  let current = target
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.join(fs.realpathSync(current), path.relative(current, target))
}

/** 相对工作目录的路径转成绝对路径，跳出工作目录时抛错 */
export function resolvePath (p = '.') {
  fs.mkdirSync(ROOT, { recursive: true })
  const rel = String(p ?? '.').trim().replace(/\\/g, '/').replace(/^\/+/, '') || '.'
  const full = path.resolve(ROOT, rel)
  if (!inside(ROOT, full) || !inside(fs.realpathSync(ROOT), realExisting(full))) {
    throw new Error('只能访问工作目录内的文件，路径请写成相对路径，如 notes/todo.txt')
  }
  return full
}

/** 绝对路径转成显示用的相对路径 */
export const display = full => path.relative(ROOT, full).replace(/\\/g, '/') || '.'

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
