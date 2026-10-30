import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const chat = await import(pathToFileURL(path.resolve(dir, '_chat.js')).href)
const grp = await import(pathToFileURL(path.resolve(dir, '_group.js')).href)
const ws = await import(pathToFileURL(path.resolve(dir, '_workspace.js')).href)
const approval = await import(pathToFileURL(path.resolve(dir, '_approval.js')).href)

const ROOT = '/'
/** 改动群文件的操作：群主、管理员、主人直接执行，其他人需要主人确认 */
const WRITE = new Set(['delete', 'rename', 'move', 'mkdir', 'rmdir', 'rename_folder'])
const NO_PERMISSION = /permission|权限|not.*admin|NOT_GROUP_ADMIN|-2\b|-4\b|-6\b/i

const size = n => (Number(n) > 0 ? ws.formatSize(Number(n)) : '')

/** ICQQ（fs.ls）和 OneBot（get_group_root_files 等）的文件 / 文件夹统一成一种格式 */
function normalize (item, parent = ROOT) {
  const isDir = item.is_dir === true || item.folder_id !== undefined || item.type === 'folder'
  return {
    id: String(item.fid ?? item.folder_id ?? item.file_id ?? item.id ?? ''),
    name: item.name ?? item.folder_name ?? item.file_name ?? '',
    dir: isDir,
    size: item.size ?? item.file_size,
    busid: item.busid,
    time: item.upload_time ?? item.create_time ?? item.modify_time,
    uploader: item.uploader_name || item.creator_name || item.uploader || item.creator || item.user_id || '',
    count: item.file_count ?? item.total_file_count,
    downloads: item.download_times,
    parent: String(item.pid ?? item.parent_id ?? parent)
  }
}

function entries (ret, parent) {
  const data = ret?.data ?? ret
  const list = Array.isArray(data) ? data : [...(data?.folders || []).map(f => ({ ...f, type: 'folder' })), ...(data?.files || [])]
  return list.map(i => normalize(i, parent))
}

/**
 * 野生号的群文件接口：ICQQ 用 group.fs；OneBot 直接调 OneBot 接口
 * TRSS 的 OneBotv11 也给群对象挂了 fs，但参数规则和 ICQQ 不同：ls 传了参数就按文件夹 ID 查（传 "/" 拿不到文件夹），
 * rm 只能删文件、还要 busid，所以 OneBot 除了上传都不走它；上传仍用它，它会先把网址 / Buffer 存成本地文件再交给协议端
 */
function fsOf (bot, gid) {
  const group = bot.pickGroup(Number(gid))
  const icqq = bot.adapter?.name === 'ICQQ'
  const gfs = icqq ? group?.fs : null
  const api = (action, params = {}) => [bot, 'sendApi', [action, { group_id: Number(gid), ...params }]]
  const call = (calls, label) => chat.invoke(calls, label).catch(err => {
    throw new Error(NO_PERMISSION.test(err.message) ? `野生号没有权限（${err.message}）：可能需要野生号是群管理员，或本群设置了仅管理员可上传` : err.message)
  })
  return {
    async ls (folder = ROOT) {
      const ret = folder === ROOT
        ? await call([[gfs, 'ls', [ROOT]], api('get_group_root_files')], '查看群文件')
        : await call([[gfs, 'ls', [folder]], api('get_group_files_by_folder', { folder_id: folder, folder })], '查看群文件')
      return entries(ret, folder)
    },
    /** 根目录加所有文件夹里的内容（QQ 群文件只有一层文件夹） */
    async all () {
      const root = await this.ls(ROOT)
      const all = [...root]
      for (const folder of root.filter(i => i.dir)) all.push(...await this.ls(folder.id).catch(() => []))
      return all
    },
    url: f => call([[gfs, 'download', [f.id]], api('get_group_file_url', { file_id: f.id, busid: f.busid })], '获取下载链接'),
    df: () => call([[gfs, 'df'], api('get_group_file_system_info')], '查看群文件空间'),
    upload: (file, name, folder) => {
      const dir = folder === ROOT ? (icqq ? ROOT : undefined) : folder
      return call([[group?.fs, 'upload', [file, dir, name]], api('upload_group_file', { file, name, ...(dir ? { folder: dir, folder_id: dir } : {}) })], '上传群文件')
    },
    rm: f => call([[gfs, 'rm', [f.id]], api('delete_group_file', { file_id: f.id, busid: f.busid })], '删除群文件'),
    rename: (f, name) => call([[gfs, 'rename', [f.id, name]], api('rename_group_file', { file_id: f.id, current_parent_directory: f.parent, new_name: name })], '重命名群文件'),
    mv: (f, folder) => call([[gfs, 'mv', [f.id, folder]], api('move_group_file', { file_id: f.id, current_parent_directory: f.parent, target_parent_directory: folder })], '移动群文件'),
    mkdir: name => call([[gfs, 'mkdir', [name]], api('create_group_file_folder', { name, folder_name: name, parent_id: ROOT })], '新建文件夹'),
    rmdir: f => call([[gfs, 'rm', [f.id]], api('delete_group_folder', { folder_id: f.id, folder: f.id })], '删除文件夹'),
    renameDir: (f, name) => call([[gfs, 'rename', [f.id, name]], api('rename_group_file_folder', { folder_id: f.id, new_folder_name: name })], '重命名文件夹')
  }
}

/** 按 id 或名字找文件 / 文件夹：先精确，再包含；有多个时列出来让用户说清楚 */
function find (list, query, wantDir) {
  const q = String(query ?? '').trim()
  if (!q) throw new Error(`请提供${wantDir ? '文件夹' : '文件'}名`)
  const pool = list.filter(i => i.dir === wantDir)
  const exact = pool.filter(i => i.id === q || i.name === q)
  const hits = exact.length ? exact : pool.filter(i => i.name.toLowerCase().includes(q.toLowerCase()))
  if (!hits.length) throw new Error(`群文件里没有找到${wantDir ? '文件夹' : '文件'}「${q}」`)
  if (hits.length > 1) {
    if (exact.length > 1) {
      throw new Error(`有 ${exact.length} 个同名${wantDir ? '文件夹' : '文件'}「${q}」：可以用 all_matches 一起处理（删除时加 keep_newest 保留最新的一个），` +
        '或者先 search 看每个的 ID，再把 ID 填进 name 指定其中一个')
    }
    throw new Error(`有 ${hits.length} 个${wantDir ? '文件夹' : '文件'}名字包含「${q}」：${[...new Set(hits.map(i => i.name))].slice(0, 10).join('、')}，请说完整的名字`)
  }
  return hits[0]
}

/** all_matches：名字完全相同（或 ID 相同）的所有文件；没有完全同名的时按包含找，只有一个才算 */
function findAll (list, query) {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('请提供文件名')
  const exact = list.filter(i => !i.dir && (i.id === q || i.name === q))
  return exact.length ? exact : [find(list, q, false)]
}

const folderName = (list, id) => (id === ROOT ? '根目录' : list.find(i => i.id === id)?.name || id)

function line (f, list) {
  // 有同名的时附上 ID，用来指定其中一个
  const dup = list.filter(i => i.dir === f.dir && i.name === f.name).length > 1 ? ` ID:${f.id}` : ''
  if (f.dir) return `📁 ${f.name}${f.count !== undefined ? `（${f.count} 个文件）` : ''}${dup}`
  const where = f.parent !== ROOT ? `［${folderName(list, f.parent)}］` : ''
  const info = [size(f.size), f.uploader && `${f.uploader} 上传`, grp.time(f.time), f.downloads && `下载 ${f.downloads} 次`].filter(Boolean).join('，')
  return `📄 ${where}${f.name}${info ? `（${info}）` : ''}${dup}`
}

/** 上传来源：网址，或 AI 工作目录里的文件；ICQQ 要传文件内容，OneBot 传网址或本地路径 */
async function source (bot, src) {
  const s = String(src ?? '').trim()
  if (!s) throw new Error('请提供要上传的文件：网址，或工作目录里的文件路径（可以先用 file_download 下载）')
  if (/^https?:\/\//i.test(s)) {
    const name = decodeURIComponent(new URL(s).pathname.split('/').pop() || '') || `file_${Date.now()}`
    if (bot.adapter?.name !== 'ICQQ') return { file: s, name }
    const res = await fetch(s, { signal: AbortSignal.timeout(60000) })
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > ws.LIMITS.download) throw new Error(`文件超过 ${ws.formatSize(ws.LIMITS.download)}`)
    return { file: buf, name }
  }
  const full = ws.resolvePath(s)
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`工作目录里没有文件 ${s}`)
  return { file: full, name: path.basename(full) }
}

async function wildIsAdmin (bot, gid) {
  try {
    const list = await grp.members(bot.pickGroup(Number(gid)))
    const self = list.find(m => String(m.user_id) === String(bot.uin))
    return self?.role === 'owner' || self?.role === 'admin'
  } catch {
    return false
  }
}

export class GroupFilesTool extends CustomTool {
  name = 'group_files'

  function = {
    name: 'group_files',
    description: '管理当前群的群文件（需要同群的野生号）：查看文件列表（list，可指定文件夹）、按名字找文件（search）、获取下载链接（url）、查看空间用量（info）、' +
      '上传文件（upload，网址或工作目录里的文件）、删除（delete）、重命名（rename）、移动到文件夹（move）、新建文件夹（mkdir）、删除文件夹（rmdir）、重命名文件夹（rename_folder）。' +
      '同名文件有多个时：用 all_matches 一起删除 / 移动（keep_newest 保留最新的一个），或用 search 结果里的 ID 填进 name 指定其中一个。' +
      'QQ 群文件只有一层文件夹，文件夹不能移动。删除、重命名、移动、文件夹操作：主人、群主、管理员直接执行，其他人会 @ 主人申请确认。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'search', 'url', 'info', 'upload', 'delete', 'rename', 'move', 'mkdir', 'rmdir', 'rename_folder'],
          description: '要做的操作，默认 list'
        },
        name: {
          type: 'string',
          description: '要操作的文件名（url / delete / rename / move）或文件夹名（list 时查看该文件夹、rmdir / rename_folder / mkdir）；search 时为关键词'
        },
        new_name: {
          type: 'string',
          description: 'rename / rename_folder 时的新名字'
        },
        folder: {
          type: 'string',
          description: 'move 的目标文件夹名（写“根目录”移回根目录）；upload 上传到哪个文件夹，不填为根目录'
        },
        source: {
          type: 'string',
          description: 'upload 时的文件：网址，或 AI 工作目录里的文件路径'
        },
        all_matches: {
          type: 'boolean',
          description: 'delete / move 时对名字完全相同的所有文件一起操作（同名文件有多个时用）'
        },
        keep_newest: {
          type: 'boolean',
          description: 'delete 且 all_matches 时保留最新上传的一个，只删其余的（清理重复文件）'
        },
        upload_name: {
          type: 'string',
          description: 'upload 时群文件里显示的文件名，不填用原文件名'
        }
      },
      required: []
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '拿不到当前消息'
    if (!e.isGroup && !e.group_id) return '只能在群里管理群文件'
    const action = args.action || 'list'
    try {
      const gid = String(e.group_id)
      const bot = grp.wildFor(e, gid)
      if (!bot) {
        if (action === 'upload') return await officialUpload(e, args)
        return '这个群里没有野生号，官方机器人只能往群文件里发文件，查看和管理群文件需要野生号'
      }
      const gfs = fsOf(bot, gid)

      if (action === 'info') {
        const d = await gfs.df() || {}
        const used = d.used ?? d.used_space
        const total = d.total ?? d.total_space
        const count = d.file_count
        const max = d.max_file_count ?? d.limit_count
        return [`已用空间：${size(used) || used}${total ? ` / ${size(total)}` : ''}`, count !== undefined && `文件数：${count}${max ? ` / ${max}` : ''}`].filter(Boolean).join('\n')
      }

      if (action === 'list') {
        const root = await gfs.ls(ROOT)
        if (args.name) {
          const folder = find(root, args.name, true)
          const list = await gfs.ls(folder.id)
          return list.length ? `文件夹「${folder.name}」里有 ${list.length} 个文件：\n${list.map(f => line(f, root)).join('\n')}` : `文件夹「${folder.name}」是空的`
        }
        if (!root.length) return '群文件是空的'
        const dirs = root.filter(f => f.dir)
        const files = root.filter(f => !f.dir)
        return `群文件根目录：${dirs.length} 个文件夹、${files.length} 个文件\n${[...dirs, ...files].slice(0, 50).map(f => line(f, root)).join('\n')}${root.length > 50 ? '\n……只显示前 50 个，可以用 search 按名字找' : ''}`
      }

      const all = action === 'mkdir' || action === 'upload' ? await gfs.ls(ROOT) : await gfs.all()

      if (action === 'search') {
        const kw = String(args.name ?? '').trim().toLowerCase()
        if (!kw) return '请提供要找的文件名关键词'
        const hits = all.filter(f => f.name.toLowerCase().includes(kw))
        return hits.length ? `找到 ${hits.length} 个：\n${hits.slice(0, 30).map(f => line(f, all)).join('\n')}` : `群文件里没有名字包含「${args.name}」的文件`
      }

      if (action === 'url') {
        const f = find(all, args.name, false)
        const ret = await gfs.url(f)
        const url = typeof ret === 'string' ? ret : ret?.url
        if (!url) return '没有拿到下载链接'
        return `「${f.name}」${size(f.size) ? `（${size(f.size)}）` : ''}的下载链接（有时效）：\n${url}`
      }

      if (action === 'upload') {
        const folder = args.folder && args.folder !== '根目录' ? find(all, args.folder, true) : null
        const src = await source(bot, args.source)
        const name = String(args.upload_name ?? '').trim() || src.name
        const run = async () => {
          await gfs.upload(src.file, name, folder?.id || ROOT)
          return `已上传「${name}」到群文件${folder ? `的「${folder.name}」文件夹` : ''}`
        }
        // 野生号是管理员时，群友能借它绕过“仅管理员可上传”的设置，这种情况普通群友上传要主人确认
        if (!e.isMaster && !['owner', 'admin'].includes(await grp.requesterRole(e)) && await wildIsAdmin(bot, gid)) {
          return await approval.guard(e, { title: `上传「${name}」到群文件`, run })
        }
        return await run()
      }

      if (!WRITE.has(action)) return `不支持的操作：${action}`
      let title, run
      if (action === 'mkdir') {
        const name = String(args.name ?? '').trim()
        if (!name) return '请提供文件夹名'
        if (all.some(f => f.dir && f.name === name)) return `已经有文件夹「${name}」了`
        title = `新建群文件夹「${name}」`
        run = async () => { await gfs.mkdir(name); return `已新建文件夹「${name}」` }
      } else if (action === 'rmdir' || action === 'rename_folder') {
        const f = find(all, args.name, true)
        if (action === 'rmdir') {
          title = `删除群文件夹「${f.name}」${f.count ? `（里面有 ${f.count} 个文件，会一起删除）` : ''}`
          run = async () => { await gfs.rmdir(f); return `已删除文件夹「${f.name}」` }
        } else {
          const name = String(args.new_name ?? '').trim()
          if (!name) return '请提供新的文件夹名'
          title = `把群文件夹「${f.name}」改名为「${name}」`
          run = async () => { await gfs.renameDir(f, name); return `已把文件夹「${f.name}」改名为「${name}」` }
        }
      } else if (args.all_matches && (action === 'delete' || action === 'move')) {
        // 批量：名字完全相同的所有文件；删除时可以保留最新上传的一个（清理重复文件）
        let files = findAll(all, args.name)
        if (action === 'delete' && args.keep_newest) {
          files = [...files].sort((a, b) => Number(b.time || 0) - Number(a.time || 0)).slice(1)
          if (!files.length) return `「${args.name}」只有一个，不需要清理`
        }
        const to = action === 'move' ? (!args.folder || args.folder === '根目录' ? { id: ROOT, name: '根目录' } : find(all, args.folder, true)) : null
        if (to) files = files.filter(f => f.parent !== to.id)
        if (!files.length) return `这些文件已经都在${to.name === '根目录' ? '根目录' : `「${to.name}」`}里了`
        const name = files[0].name
        const where = to ? (to.id === ROOT ? '根目录' : `文件夹「${to.name}」`) : ''
        title = action === 'delete'
          ? `删除 ${files.length} 个群文件「${name}」${args.keep_newest ? '（保留最新上传的一个）' : ''}`
          : `把 ${files.length} 个群文件「${name}」移动到${where}`
        run = async () => {
          const failed = []
          for (const f of files) {
            try {
              await (action === 'delete' ? gfs.rm(f) : gfs.mv(f, to.id))
            } catch (err) {
              failed.push(err.message)
            }
          }
          const ok = files.length - failed.length
          if (!ok) throw new Error(`${files.length} 个都没能${action === 'delete' ? '删除' : `移动到${where}`}：${failed[0]}`)
          const done = action === 'delete' ? `已删除 ${ok} 个「${name}」` : `已把 ${ok} 个「${name}」移动到${where}`
          return `${done}${failed.length ? `，${failed.length} 个失败：${failed[0]}` : ''}`
        }
      } else {
        const f = find(all, args.name, false)
        if (action === 'delete') {
          title = `删除群文件「${f.name}」`
          run = async () => { await gfs.rm(f); return `已删除群文件「${f.name}」` }
        } else if (action === 'rename') {
          const name = String(args.new_name ?? '').trim()
          if (!name) return '请提供新文件名'
          title = `把群文件「${f.name}」改名为「${name}」`
          run = async () => { await gfs.rename(f, name); return `已把「${f.name}」改名为「${name}」` }
        } else {
          const to = !args.folder || args.folder === '根目录' ? { id: ROOT, name: '根目录' } : find(all, args.folder, true)
          if (to.id === f.parent) return `「${f.name}」已经在${to.name === '根目录' ? '根目录' : `「${to.name}」`}里了`
          title = `把群文件「${f.name}」移动到${to.id === ROOT ? '根目录' : `文件夹「${to.name}」`}`
          run = async () => { await gfs.mv(f, to.id); return `已把「${f.name}」移动到${to.id === ROOT ? '根目录' : `「${to.name}」`}` }
        }
      }
      if (e.isMaster || ['owner', 'admin'].includes(await grp.requesterRole(e))) return await run()
      return await approval.guard(e, { title, run })
    } catch (err) {
      return chat.errorText(err)
    }
  }
}

/** 没有野生号时：官方机器人把文件发到群里（会进群文件根目录） */
async function officialUpload (e, args) {
  if (args.folder && args.folder !== '根目录') return '这个群里没有野生号，官方机器人只能把文件传到群文件根目录'
  const src = String(args.source ?? '').trim()
  if (!src) return '请提供要上传的文件：网址，或工作目录里的文件路径'
  const file = /^https?:\/\//i.test(src) ? src : ws.resolvePath(src)
  const name = String(args.upload_name ?? '').trim() || path.basename(/^https?:\/\//i.test(src) ? new URL(src).pathname : file)
  const ret = await e.reply({ type: 'file', file, name })
  return chat.sent(ret) ? `已把「${name}」发到群文件` : `上传失败：${chat.failReason(ret)}`
}

export default new GroupFilesTool()
