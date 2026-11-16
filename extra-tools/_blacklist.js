/**
 * 临时拉黑：把人加进云崽自带的黑名单（config/config/other.yaml），由云崽拦截：被拉黑的人发的消息所有插件都不处理；
 * 到时间后自动移出。
 *
 * - TRSS-Yunzai 的字段是 blackUser，Miao-Yunzai 是 blackQQ：看配置文件里有哪个
 * - 用 Yunzai 自带的 yaml 包改文件，保留注释；同时改内存里的配置，马上生效（云崽监听到文件变化也会重新读）
 * - QQ 号存成数字，官方机器人那边没绑定 QQ 号的人存原始账号字符串（云崽按 e.user_id 比对）
 * - 解除时间记在 plugins/chatgpt-plugin/data/temp-blacklist.json，重启后继续有效；每 20 秒检查一次到期的
 * - 只移出这里加进去的人：主人手动加的（不在记录里）永远不会被自动移出
 * 插件启动时由 apps/extraTools.js 调用 start()；以 _ 开头，不会被当成工具登记。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const FILE = path.resolve('./config/config/other.yaml')
const RECORD = path.resolve('./plugins/chatgpt-plugin/data/temp-blacklist.json')
const CHECK_INTERVAL = 20 * 1000

export const DEFAULT_MINUTES = 10
export const MAX_MINUTES = 24 * 60

let YAML
let cfg
const yamlLib = async () => (YAML ??= (await import('yaml')).default)
const yunzaiCfg = async () => (cfg ??= (await import(pathToFileURL(path.resolve('./lib/config/config.js')).href)).default)

const toValue = id => (/^\d{5,12}$/.test(String(id)) ? Number(id) : String(id))

// 热重载后共用同一份状态，避免出现两个定时器
const state = (globalThis[Symbol.for('chatgpt-extra-tools-blacklist')] ??= { records: null, timer: null, busy: false })

/** @returns {Record<string, { until: number, key: string }>} */
function records () {
  if (state.records) return state.records
  try {
    state.records = fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, 'utf8')) : {}
  } catch (err) {
    globalThis.logger?.error?.(`[黑名单] 读取 ${RECORD} 失败：${err.message}`)
    state.records = {}
  }
  if (!state.records || typeof state.records !== 'object' || Array.isArray(state.records)) state.records = {}
  return state.records
}

function saveRecords () {
  fs.mkdirSync(path.dirname(RECORD), { recursive: true })
  fs.writeFileSync(RECORD, JSON.stringify(state.records, null, 2))
}

/** 读云崽的 other.yaml，返回文档、字段名和当前名单 */
async function readList () {
  if (!fs.existsSync(FILE)) throw new Error('找不到云崽的 config/config/other.yaml')
  const Y = await yamlLib()
  const doc = Y.parseDocument(fs.readFileSync(FILE, 'utf8'))
  const key = doc.has('blackUser') ? 'blackUser' : doc.has('blackQQ') ? 'blackQQ' : (globalThis.Bot?.bots ? 'blackUser' : 'blackQQ')
  const node = doc.get(key, true)
  const current = (node?.toJSON ? node.toJSON() : node) || []
  const list = Array.isArray(current) ? current : []
  return { Y, doc, key, node, list }
}

/** 云崽内存里的 other 配置（拿不到时返回 null） */
async function memoryOther () {
  try {
    const c = await yunzaiCfg()
    return (typeof c.getOther === 'function' ? c.getOther() : c.other) || null
  } catch {
    return null
  }
}

async function addToYunzai (id) {
  const { Y, doc, key, node, list } = await readList()
  const already = list.map(String).includes(id)
  if (!already) {
    if (Y.isSeq(node)) {
      // 已经是列表：直接加在后面，注释原样保留
      node.add(doc.createNode(toValue(id)))
    } else {
      // 空值（blackQQ: 后面什么都没写）：换成列表。yaml 把下一行的注释（如“# 白名单群”）挂在这个空值上，
      // 直接换掉会丢，挪到下一个字段前面
      const seq = doc.createNode([...list, toValue(id)])
      if (node?.comment) {
        const items = doc.contents?.items || []
        const next = items[items.findIndex(p => p.key?.value === key) + 1]
        if (next?.key) next.key.commentBefore = next.key.commentBefore ? `${node.comment}\n${next.key.commentBefore}` : node.comment
        else seq.comment = node.comment
      }
      doc.set(key, seq)
    }
    fs.writeFileSync(FILE, doc.toString())
  }
  // 内存里的配置也加上，不用等云崽重新读文件
  const other = await memoryOther()
  if (Array.isArray(other?.[key])) {
    if (!other[key].map(String).includes(id)) other[key].push(toValue(id))
  } else if (other) {
    other[key] = [toValue(id)]
  }
  return { key, already }
}

async function removeFromYunzai (id) {
  const { Y, doc, key, node } = await readList()
  // 两个字段都检查一遍，防止拉黑后云崽换了版本
  for (const k of new Set([key, 'blackUser', 'blackQQ'])) {
    const n = k === key ? node : doc.get(k, true)
    if (!Y.isSeq(n)) continue
    let changed = false
    for (let i = n.items.length - 1; i >= 0; i--) {
      const item = n.items[i]
      if (String(item?.value ?? item) === id) {
        n.delete(i)
        changed = true
      }
    }
    if (changed) fs.writeFileSync(FILE, doc.toString())
  }
  const other = await memoryOther()
  for (const k of ['blackUser', 'blackQQ']) {
    const arr = other?.[k]
    if (!Array.isArray(arr)) continue
    for (let i = arr.length - 1; i >= 0; i--) if (String(arr[i]) === id) arr.splice(i, 1)
  }
}

/**
 * 临时拉黑：加进云崽的黑名单，minutes 分钟后自动移出
 * @param {string} userId 发消息的人（e.user_id）
 * @param {number} minutes 拉黑多久（分钟）
 * @returns {Promise<{ key: string, permanent: boolean, until: number }>}
 *   permanent 为 true 表示他本来就在黑名单里且不是这里临时加的（主人手动加的），不会被自动移出
 */
export async function block (userId, minutes = DEFAULT_MINUTES) {
  const id = String(userId)
  const mins = Math.min(MAX_MINUTES, Math.max(1, Math.round(Number(minutes) || DEFAULT_MINUTES)))
  const rec = records()
  const { key, already } = await addToYunzai(id)
  if (already && !rec[id]) return { key, permanent: true, until: 0 }
  const until = Date.now() + mins * 60 * 1000
  rec[id] = { until: Math.max(until, rec[id]?.until || 0), key }
  saveRecords()
  return { key, permanent: false, until: rec[id].until }
}

/** 移出临时拉黑（只处理记录里有的人） */
export async function unblock (userId) {
  const id = String(userId)
  const rec = records()
  if (!rec[id]) return false
  await removeFromYunzai(id)
  delete rec[id]
  saveRecords()
  return true
}

export async function tick () {
  if (state.busy) return
  state.busy = true
  try {
    const now = Date.now()
    for (const [id, r] of Object.entries(records())) {
      if (r.until > now) continue
      try {
        await unblock(id)
        globalThis.logger?.mark?.(`[黑名单] ${id} 拉黑到期，已移出`)
      } catch (err) {
        globalThis.logger?.warn?.(`[黑名单] ${id} 移出失败，稍后重试：${err.message}`)
      }
    }
  } finally {
    state.busy = false
  }
}

export function start () {
  if (state.timer) return
  records()
  tick().catch(err => globalThis.logger?.error?.('[黑名单] 检查失败', err))
  state.timer = setInterval(() => tick().catch(err => globalThis.logger?.error?.('[黑名单] 检查失败', err)), CHECK_INTERVAL)
  state.timer.unref?.()
}
