import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const ws = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_workspace.js')).href)

export class FileEditTool extends CustomTool {
  name = 'file_edit'

  function = {
    name: 'file_edit',
    description: '修改工作目录里文本文件的一部分：把 old_text 原样替换成 new_text。old_text 要从文件里原样复制（不含行号），' +
      '且在文件里只出现一次；要全部替换时设 replace_all。改之前不确定内容时先用 file_read 查看。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对工作目录的文件路径'
        },
        old_text: {
          type: 'string',
          description: '要被替换的原文'
        },
        new_text: {
          type: 'string',
          description: '替换后的内容，为空表示删除 old_text'
        },
        replace_all: {
          type: 'boolean',
          description: '替换所有出现的地方，默认 false'
        }
      },
      required: ['path', 'old_text', 'new_text']
    }
  }

  async run (args) {
    try {
      const file = ws.resolvePath(args.path)
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return `文件不存在：${ws.display(file)}`
      const buffer = fs.readFileSync(file)
      if (ws.isBinary(buffer)) return '二进制文件不能编辑'
      const text = buffer.toString('utf8')
      const oldText = String(args.old_text ?? '')
      const newText = String(args.new_text ?? '')
      if (!oldText) return 'old_text 不能为空；要整个改写请用 file_write'
      const count = text.split(oldText).length - 1
      if (!count) return '文件里没有找到 old_text，请先用 file_read 查看原文后原样复制'
      if (count > 1 && !args.replace_all) return `old_text 在文件里出现了 ${count} 次，请多带一些上下文让它唯一，或设置 replace_all`
      const result = args.replace_all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText)
      if (Buffer.byteLength(result) > ws.LIMITS.write) return `修改后文件会超过 ${ws.formatSize(ws.LIMITS.write)}，已取消`
      fs.writeFileSync(file, result)
      return `已修改 ${ws.display(file)}，替换了 ${args.replace_all ? count : 1} 处`
    } catch (err) {
      return ws.errorText(err)
    }
  }
}

export default new FileEditTool()
