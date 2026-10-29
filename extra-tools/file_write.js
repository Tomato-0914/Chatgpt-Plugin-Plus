import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const ws = await import(pathToFileURL(path.resolve(dir, '_workspace.js')).href)
const { redact } = await import(pathToFileURL(path.resolve(dir, '_redact.js')).href)

export class FileWriteTool extends CustomTool {
  name = 'file_write'

  function = {
    name: 'file_write',
    description: '新建或写入文本文件（自动创建上级目录）。整个改写用 overwrite，在末尾追加用 append；只改其中一部分请用 file_edit。' +
      'root=yunzai 可以写框架里的文件（仅主人），写之前会自动备份；含密钥的文件不能整体覆盖，请用 file_edit。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对根目录的文件路径，如 notes/todo.txt'
        },
        content: {
          type: 'string',
          description: '要写入的文本内容'
        },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: 'overwrite=覆盖（默认），append=追加到末尾'
        },
        root: ws.ROOT_PARAM
      },
      required: ['path', 'content']
    }
  }

  async run (args, context) {
    try {
      const s = ws.scope(context?.getEvent?.(), args.root)
      const file = ws.resolvePath(args.path, s)
      const name = ws.display(file, s)
      if (file === s.base) return '请提供文件名'
      const exists = fs.existsSync(file)
      if (exists && fs.statSync(file).isDirectory()) return `${name} 是目录`
      const content = String(args.content ?? '')
      const append = args.mode === 'append'
      const before = exists ? fs.statSync(file).size : 0
      const size = Buffer.byteLength(content) + (append ? before : 0)
      if (size > ws.LIMITS.write) return `写入后文件会超过 ${ws.formatSize(ws.LIMITS.write)}，已取消`

      let backup = ''
      if (s.yunzai) {
        // AI 看到的框架文件是打码过的，不能把 *** 写回去，也不能整体覆盖含密钥的文件，否则真实密钥会丢
        if (content.includes('***')) return '内容里有 ***（打码后的密钥），不能写进框架文件；只修改需要改的部分请用 file_edit'
        if (exists && !append) {
          const original = fs.readFileSync(file, 'utf8')
          if (redact(original) !== original) return `${name} 里有密钥，不能整体覆盖；请用 file_edit 只修改需要改的部分`
        }
        backup = ws.backup(file)
      }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (append) fs.appendFileSync(file, content)
      else fs.writeFileSync(file, content)
      const action = append ? '已追加到' : before ? '已覆盖' : '已创建'
      return `${action} ${name}，现在共 ${ws.formatSize(fs.statSync(file).size)}${backup ? `（原文件已备份，可用 file_restore 还原）` : ''}`
    } catch (err) {
      return ws.errorText(err)
    }
  }
}

export default new FileWriteTool()
