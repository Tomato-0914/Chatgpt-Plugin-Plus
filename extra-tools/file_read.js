import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const ws = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_workspace.js')).href)

export class FileReadTool extends CustomTool {
  name = 'file_read'

  function = {
    name: 'file_read',
    description: '查看工作目录里文本文件的内容，带行号。文件较长时用 offset、limit 分段读取。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对工作目录的文件路径，如 notes/todo.txt'
        },
        offset: {
          type: 'number',
          description: '从第几行开始读，默认 1'
        },
        limit: {
          type: 'number',
          description: '最多读多少行，默认 200'
        }
      },
      required: ['path']
    }
  }

  async run (args) {
    try {
      const file = ws.resolvePath(args.path)
      if (!fs.existsSync(file)) return `文件不存在：${ws.display(file)}`
      const stat = fs.statSync(file)
      if (stat.isDirectory()) return `${ws.display(file)} 是目录，请用 file_list 查看`
      if (stat.size > ws.LIMITS.read) return `文件有 ${ws.formatSize(stat.size)}，超过 ${ws.formatSize(ws.LIMITS.read)}，无法直接查看`
      const buffer = fs.readFileSync(file)
      if (ws.isBinary(buffer)) return `${ws.display(file)} 是二进制文件（${ws.formatSize(stat.size)}），无法查看内容，可以用 file_send 发送`

      const lines = buffer.toString('utf8').split(/\r?\n/)
      const offset = Math.max(Math.floor(Number(args.offset) || 1), 1)
      const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 200), 1), 1000)
      if (offset > lines.length) return `文件只有 ${lines.length} 行`
      const end = Math.min(offset + limit - 1, lines.length)
      const width = String(end).length
      const body = lines.slice(offset - 1, end).map((line, i) => `${String(offset + i).padStart(width)}| ${line}`).join('\n')
      const more = end < lines.length ? `\n（共 ${lines.length} 行，还有 ${lines.length - end} 行，从 offset=${end + 1} 继续读取）` : ''
      return `${ws.display(file)}（第 ${offset}-${end} 行，共 ${lines.length} 行）：\n${body}${more}`
    } catch (err) {
      return ws.errorText(err)
    }
  }
}

export default new FileReadTool()
