import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const ws = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_workspace.js')).href)

const stampText = stamp => stamp.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d{3})?$/, '$1-$2-$3 $4:$5:$6')

export class FileRestoreTool extends CustomTool {
  name = 'file_restore'

  function = {
    name: 'file_restore',
    description: '还原框架文件（仅主人）：file_write / file_edit / file_download 修改框架文件前都会自动备份，' +
      '改坏了用这个还原。action=list 查看某个文件的备份，action=restore 还原到最近一次（或指定的）备份。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'restore'],
          description: 'list=列出备份（默认），restore=还原'
        },
        path: {
          type: 'string',
          description: '框架里的文件路径（相对 Yunzai 根目录）'
        },
        backup: {
          type: 'string',
          description: 'restore 时指定备份时间（list 里显示的编号），不填为最近一次'
        }
      },
      required: ['path']
    }
  }

  async run (args, context) {
    try {
      const s = ws.scope(context?.getEvent?.(), 'yunzai')
      const file = ws.resolvePath(args.path, s)
      const name = ws.display(file, s)
      const backups = ws.backupsOf(file)
      if (!backups.length) return `${name} 没有备份`
      if (args.action !== 'restore') {
        return `${name} 的备份（从新到旧）：\n${backups.slice(0, 20).map(b => `${b.stamp}（${stampText(b.stamp)}）`).join('\n')}`
      }
      const chosen = args.backup ? backups.find(b => b.stamp === String(args.backup).trim()) : backups[0]
      if (!chosen) return `没有找到备份 ${args.backup}，先用 action=list 查看`
      // 还原前把当前文件也备份一次，还原错了还能再换回来
      ws.backup(file)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.copyFileSync(chosen.file, file)
      return `已把 ${name} 还原到 ${stampText(chosen.stamp)} 的备份（还原前的内容也已备份）`
    } catch (err) {
      return ws.errorText(err)
    }
  }
}

export default new FileRestoreTool()
