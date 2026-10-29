import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const ws = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_workspace.js')).href)

export class FileWriteTool extends CustomTool {
  name = 'file_write'

  function = {
    name: 'file_write',
    description: '在工作目录里新建或写入文本文件（自动创建上级目录）。整个改写用 overwrite，在末尾追加用 append；只改其中一部分请用 file_edit。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对工作目录的文件路径，如 notes/todo.txt'
        },
        content: {
          type: 'string',
          description: '要写入的文本内容'
        },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: 'overwrite=覆盖（默认），append=追加到末尾'
        }
      },
      required: ['path', 'content']
    }
  }

  async run (args) {
    try {
      const file = ws.resolvePath(args.path)
      if (file === ws.ROOT) return '请提供文件名'
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) return `${ws.display(file)} 是目录`
      const content = String(args.content ?? '')
      const append = args.mode === 'append'
      const before = fs.existsSync(file) ? fs.statSync(file).size : 0
      const size = Buffer.byteLength(content) + (append ? before : 0)
      if (size > ws.LIMITS.write) return `写入后文件会超过 ${ws.formatSize(ws.LIMITS.write)}，已取消`
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (append) fs.appendFileSync(file, content)
      else fs.writeFileSync(file, content)
      const action = append ? '已追加到' : before ? '已覆盖' : '已创建'
      return `${action} ${ws.display(file)}，现在共 ${ws.formatSize(fs.statSync(file).size)}`
    } catch (err) {
      return ws.errorText(err)
    }
  }
}

export default new FileWriteTool()
