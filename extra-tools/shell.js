import { exec } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CustomTool } from 'chaite'

const dir = './plugins/chatgpt-plugin/extra-tools'
const approval = await import(pathToFileURL(path.resolve(dir, '_approval.js')).href)
const { redact } = await import(pathToFileURL(path.resolve(dir, '_redact.js')).href)

const MAX_OUTPUT = 3000

/** 在 Yunzai 根目录执行命令，输出脱敏后截断 */
function runCommand (command, timeout) {
  return new Promise(resolve => {
    exec(command, { cwd: process.cwd(), timeout: timeout * 1000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      let out = [stdout, stderr].filter(s => s && s.trim()).join('\n--- stderr ---\n').trim()
      if (err?.killed) out += `\n（超过 ${timeout} 秒，已终止）`
      else if (err && typeof err.code === 'number') out += `\n（退出码 ${err.code}）`
      else if (err && !out) out = err.message
      out = redact(out.trim() || '（没有输出）')
      if (out.length > MAX_OUTPUT) out = `${out.slice(0, MAX_OUTPUT)}\n……（输出共 ${out.length} 字，已截断）`
      resolve(out)
    })
  })
}

export class ShellTool extends CustomTool {
  name = 'shell'

  function = {
    name: 'shell',
    description: '在机器人服务器上（Yunzai 根目录）执行 shell 命令并返回输出，输出里的密钥、密码会被打码。' +
      '主人要求时直接执行；其他人要求时会自动 @ 主人申请确认，主人确认后才执行，结果直接发到群里。' +
      '只在用户明确要求执行命令、查看服务器状态时使用；不要执行删除文件、关机重启等破坏性命令，除非主人明确要求。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的命令（单行）'
        },
        timeout: {
          type: 'number',
          description: '超时秒数，默认 60，最多 300'
        }
      },
      required: ['command']
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (!e) return '当前没有可用的聊天'
    const command = String(args.command || '').trim()
    if (!command) return '请提供要执行的命令'
    if (command.length > 1000) return '命令太长了'
    const timeout = Math.min(Math.max(Math.floor(Number(args.timeout) || 60), 1), 300)
    return approval.guard(e, {
      title: `执行命令：${command.length > 200 ? `${command.slice(0, 200)}…` : command}`,
      run: async () => `输出：\n${await runCommand(command, timeout)}`
    })
  }
}

export default new ShellTool()
