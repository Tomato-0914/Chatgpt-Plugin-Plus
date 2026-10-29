import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const ws = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_workspace.js')).href)

export class FileListTool extends CustomTool {
  name = 'file_list'

  function = {
    name: 'file_list',
    description: '列出目录里的文件和子目录，显示大小和修改时间。读写、发送文件前不确定文件名时先调用。' +
      '默认是 AI 工作目录；主人要看机器人框架（插件、配置、日志等）时用 root=yunzai。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对根目录的子目录，默认为根目录'
        },
        root: ws.ROOT_PARAM
      },
      required: []
    }
  }

  async run (args, context) {
    try {
      const s = ws.scope(context?.getEvent?.(), args.root)
      const dir = ws.resolvePath(args.path, s)
      if (!fs.existsSync(dir)) return `目录不存在：${ws.display(dir, s)}`
      if (!fs.statSync(dir).isDirectory()) return `${ws.display(dir, s)} 是文件，不是目录`
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => !(s.yunzai && ws.isBlocked(entry.name)))
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'))
      if (!entries.length) return `目录 ${ws.display(dir, s)} 是空的`
      const lines = entries.slice(0, 200).map(entry => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return `📁 ${entry.name}/`
        if (entry.isSymbolicLink()) return `🔗 ${entry.name}（软链接）`
        const stat = fs.statSync(full)
        const time = stat.mtime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
        return `📄 ${entry.name}（${ws.formatSize(stat.size)}，${time}）`
      })
      if (entries.length > 200) lines.push(`……共 ${entries.length} 项，只显示前 200 项`)
      return `${s.yunzai ? '框架' : '工作'}目录 ${ws.display(dir, s)}：\n${lines.join('\n')}`
    } catch (err) {
      return ws.errorText(err)
    }
  }
}

export default new FileListTool()
