import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const ws = await import(pathToFileURL(path.resolve('./plugins/chatgpt-plugin/extra-tools/_workspace.js')).href)

/** 发送结果里是否有消息 id（官方机器人失败时返回 { message_id: [], error: [...] }） */
function sent (ret) {
  if (!ret) return false
  if (Array.isArray(ret.message_id)) return ret.message_id.length > 0
  return ret.message_id != null && ret.message_id !== ''
}

export class FileSendTool extends CustomTool {
  name = 'file_send'

  function = {
    name: 'file_send',
    description: '把文件作为文件消息发到当前聊天（群文件或私聊文件）。生成或下载好文件、用户要求发文件时调用。' +
      '框架目录（root=yunzai）里的文件只能由主人在私聊里发送，避免配置原文发到群里。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '相对根目录的文件路径'
        },
        name: {
          type: 'string',
          description: '发送时显示的文件名，默认用原文件名'
        },
        root: ws.ROOT_PARAM
      },
      required: ['path']
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (typeof e?.reply !== 'function') return '当前没有可用的聊天，无法发送文件'
    try {
      const s = ws.scope(e, args.root)
      if (s.yunzai && (e.isGroup || e.group_id)) return '框架目录里的文件只能在私聊里发送（可能含有密钥），请私聊机器人再发'
      const file = ws.resolvePath(args.path, s)
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return `文件不存在：${ws.display(file, s)}`
      const name = String(args.name || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || path.basename(file)
      const ret = await e.reply({ type: 'file', file, name })
      if (!sent(ret)) {
        const reason = ret?.error?.[0]?.message || ret?.error?.[0] || '没有返回消息 ID'
        return `文件发送失败：${reason}`
      }
      return `已发送文件 ${name}（${ws.formatSize(fs.statSync(file).size)}），不需要再重复说明文件内容`
    } catch (err) {
      return ws.errorText(err)
    }
  }
}

export default new FileSendTool()
