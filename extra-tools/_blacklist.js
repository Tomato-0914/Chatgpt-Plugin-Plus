/**
 * 把人加进云崽自带的黑名单（config/config/other.yaml），由云崽拦截：被拉黑的人发的消息所有插件都不处理。
 * 查看、解除用云崽或其他插件已有的命令，这里只负责加。
 *
 * - TRSS-Yunzai 的字段是 blackUser，Miao-Yunzai 是 blackQQ：看配置文件里有哪个
 * - 用 Yunzai 自带的 yaml 包改文件，保留注释；同时改内存里的配置，马上生效（云崽监听到文件变化也会重新读）
 * - QQ 号存成数字，官方机器人那边没绑定 QQ 号的人存原始账号字符串（云崽按 e.user_id 比对）
 * 以 _ 开头，不会被当成工具登记。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const FILE = path.resolve('./config/config/other.yaml')

let YAML
let cfg
const yamlLib = async () => (YAML ??= (await import('yaml')).default)
const yunzaiCfg = async () => (cfg ??= (await import(pathToFileURL(path.resolve('./lib/config/config.js')).href)).default)

const toValue = id => (/^\d{5,12}$/.test(String(id)) ? Number(id) : String(id))

/**
 * 加进云崽的黑名单
 * @param {string} userId 发消息的人（e.user_id）
 * @returns {Promise<{ key: string, already: boolean }>} key 为写入的字段名
 */
export async function block (userId) {
  const id = String(userId)
  if (!fs.existsSync(FILE)) throw new Error('找不到云崽的 config/config/other.yaml')
  const Y = await yamlLib()
  const doc = Y.parseDocument(fs.readFileSync(FILE, 'utf8'))
  const key = doc.has('blackUser') ? 'blackUser' : doc.has('blackQQ') ? 'blackQQ' : (globalThis.Bot?.bots ? 'blackUser' : 'blackQQ')
  const node = doc.get(key, true)
  const current = (node?.toJSON ? node.toJSON() : node) || []
  const list = Array.isArray(current) ? current : []
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
  try {
    const c = await yunzaiCfg()
    const other = typeof c.getOther === 'function' ? c.getOther() : c.other
    if (Array.isArray(other?.[key]) && !other[key].map(String).includes(id)) other[key].push(toValue(id))
    else if (other && !other[key]) other[key] = [toValue(id)]
  } catch {}
  return { key, already }
}
