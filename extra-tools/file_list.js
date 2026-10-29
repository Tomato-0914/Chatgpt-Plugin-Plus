import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const ws = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_workspace.js')).href)

export class FileListTool extends CustomTool {
  name = 'file_list'

  function = {
    name: 'file_list',
    description: '列出工作目录（AI 专用的文件夹）里的文件和子目录，显示大小和修改时间。读写、发送文件前不确定文件名时先调用。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对工作目录的子目录，默认为根目录'
        }
      },
      required: []
    }
  }

  async run (args) {
    try {
      const dir = ws.resolvePath(args.path)
      if (!fs.existsSync(dir)) return `目录不存在：${ws.display(dir)}`
      if (!fs.statSync(dir).isDirectory()) return `${ws.display(dir)} 是文件，不是目录`
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'))
      if (!entries.length) return `目录 ${ws.display(dir)} 是空的`
      const lines = entries.slice(0, 200).map(entry => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return `📁 ${entry.name}/`
        if (entry.isSymbolicLink()) return `🔗 ${entry.name}（软链接）`
        const stat = fs.statSync(full)
        const time = stat.mtime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
        return `📄 ${entry.name}（${ws.formatSize(stat.size)}，${time}）`
      })
      if (entries.length > 200) lines.push(`……共 ${entries.length} 项，只显示前 200 项`)
      return `目录 ${ws.display(dir)}：\n${lines.join('\n')}`
    } catch (err) {
      return ws.errorText(err)
    }
  }
}

export default new FileListTool()
