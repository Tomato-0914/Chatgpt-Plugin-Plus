import { CustomTool } from 'chaite'

const MAX_RESULTS = 15
const EXEC_TIMEOUT = 30 * 1000
const REPEAT_WINDOW = 10 * 1000
/** 同一会话里刚执行过的命令，防止模型重复调用刷屏 */
const recent = new Map()

let loaderRef
async function getLoader () {
  if (loaderRef?.priority) return loaderRef
  try {
    loaderRef = (await import('../../../../lib/plugins/loader.js')).default
  } catch {}
  return loaderRef?.priority ? loaderRef : null
}

const toReg = reg => {
  try {
    if (reg instanceof RegExp) return new RegExp(reg.source, reg.flags)
    if (typeof reg === 'string' && reg) return new RegExp(reg)
  } catch {}
  return null
}

/** 正则转成人能看懂的命令格式 */
function readable (reg) {
  return reg.source
    .replace(/^\^/, '').replace(/\$$/, '')
    .replace(/\\s[*+]/g, ' ')
    .replace(/\[\\s\\S\][*+]|\.[*+]/g, '<内容>')
    .replace(/\\d[*+]|\\d\{[\d,]+\}/g, '<数字>')
    .replace(/\\([#*+?.(){}[\]\\|^$])/g, '$1')
}

/** 不允许调用 chatgpt-plugin 自身的命令，避免递归 */
const isSelf = item => String(item?.key || '').replaceAll('\\', '/').startsWith('chatgpt-plugin/')

/** 当前触发者是否有权限执行这条规则（不回复“暂无权限”） */
function allowed (e, rule) {
  const p = String(rule?.permission || 'all').toLowerCase()
  if (p === 'all' || e.isMaster) return true
  if (p === 'master') return false
  if (p === 'owner') return !!e.member?.is_owner
  if (p === 'admin') return !!(e.member?.is_owner || e.member?.is_admin)
  return true
}

function eventOk (loader, e, rule) {
  if (!rule?.event || typeof loader.filtEvent !== 'function') return true
  try {
    return loader.filtEvent(e, rule) === true
  } catch {
    return false
  }
}

/** 插件监听的事件是否包含当前消息（与 Yunzai 一致，戳一戳等通知类插件不处理消息） */
const pluginOk = (loader, e, item) => eventOk(loader, e, item?.plugin)

/**
 * 能匹配任意文字的规则（.*、空规则等）：AI 聊天、伪人、消息记录这类每条消息都要过一遍的插件。
 * 以及能匹配任意 # 开头文字的通配规则。它们不是“命令”，搜索时会占满结果，执行时也可能被误触发，一律跳过
 */
const catchAll = reg => ['', '\u0000随机文字 zx7q', '#\u0000随机文字 zx7q'].some(text => reg.test(text))

/** 规则是不是一条可调用的命令 */
function commandRule (loader, e, item, rule) {
  const reg = toReg(rule?.reg)
  if (!reg || catchAll(reg)) return null
  if (!pluginOk(loader, e, item) || !eventOk(loader, e, rule)) return null
  return reg
}

/** 以当前用户的身份构造一条命令消息，回复照常发到当前会话 */
function commandEvent (loader, e, command, onReply) {
  const desc = Object.getOwnPropertyDescriptors(e)
  for (const key of ['msg', 'raw_message', 'original_msg', 'message', 'reply', 'game', 'isSr', 'isGs']) delete desc[key]
  const ce = Object.create(Object.getPrototypeOf(e), desc)
  let msg = command
  let game = e.game
  if (loader.srReg?.test(msg)) {
    game = 'sr'
    msg = msg.replace(loader.srReg, '#星铁')
  } else if (loader.zzzReg?.test(msg)) {
    game = 'zzz'
    msg = msg.replace(loader.zzzReg, '#绝区零')
  }
  Object.assign(ce, {
    msg,
    raw_message: command,
    message: [{ type: 'text', text: command }],
    game,
    reply: (...args) => {
      onReply()
      return e.reply(...args)
    }
  })
  Object.defineProperty(ce, 'isSr', { get: () => ce.game === 'sr', set: v => { ce.game = v ? 'sr' : 'gs' }, configurable: true })
  Object.defineProperty(ce, 'isGs', { get: () => ce.game === 'gs', set: v => { ce.game = v ? 'gs' : 'sr' }, configurable: true })
  return ce
}

function search (loader, e, query) {
  const keyword = query.toLowerCase()
  const found = []
  for (const item of loader.priority) {
    if (isSelf(item) || !Array.isArray(item?.plugin?.rule)) continue
    for (const rule of item.plugin.rule) {
      const reg = commandRule(loader, e, item, rule)
      if (!reg || !allowed(e, rule)) continue
      const pattern = readable(reg)
      const exact = reg.test(query)
      const text = `${pattern}\n${item.name || ''}\n${item.plugin?.dsc || ''}\n${rule.fnc || ''}\n${item.key || ''}`.toLowerCase()
      if (!exact && !text.includes(keyword)) continue
      found.push({ exact, priority: Number(item.priority) || 0, line: `【${item.name || '未知插件'}】${pattern}` })
    }
  }
  found.sort((a, b) => b.exact - a.exact || a.priority - b.priority)
  const lines = [...new Set(found.map(f => f.line))].slice(0, MAX_RESULTS)
  if (!lines.length) return `没有找到与“${query}”相关、当前用户可用的命令，可以换个关键词再搜`
  return `找到 ${lines.length} 条可用命令（格式中 <内容>、<数字> 需替换成实际内容）：\n${lines.join('\n')}\n\n用 action=execute 并在 command 里写出完整命令即可执行。`
}

async function execute (loader, e, command) {
  const key = `${e.self_id}:${e.group_id || 'p'}:${e.user_id}:${command}`
  const now = Date.now()
  for (const [k, t] of recent) if (now - t > REPEAT_WINDOW) recent.delete(k)
  if (recent.has(key)) return '这条命令刚刚执行过，请不要重复执行'
  recent.set(key, now)

  let replies = 0
  const ce = commandEvent(loader, e, command, () => replies++)
  let matched = false
  // 与 Yunzai 的分发顺序一致：按优先级依次匹配，处理函数返回 false 时交给下一条规则
  for (const item of loader.priority) {
    if (isSelf(item) || !Array.isArray(item?.plugin?.rule)) continue
    for (const rule of item.plugin.rule) {
      const reg = commandRule(loader, ce, item, rule)
      if (!reg || !reg.test(ce.msg)) continue
      matched = true
      if (!allowed(ce, rule)) return `没有权限执行这条命令（需要 ${rule.permission} 权限）`
      const plugin = Object.assign(new item.class(ce), { e: ce })
      if (typeof plugin[rule.fnc] !== 'function') continue
      let timer
      try {
        const res = await Promise.race([
          Promise.resolve(plugin[rule.fnc](ce)),
          new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), EXEC_TIMEOUT) })
        ])
        if (res === 'timeout') return `命令已开始执行，但超过 ${EXEC_TIMEOUT / 1000} 秒还没结束，结果稍后会由插件直接发出`
        if (res === false) continue
        return replies
          ? `命令已由【${item.name}】执行，结果已经直接发到聊天里了，不要再重复描述结果内容，简短回应即可`
          : `命令已由【${item.name}】执行，插件没有回复内容`
      } catch (err) {
        return `命令执行出错：${String(err?.message || err).slice(0, 200)}`
      } finally {
        clearTimeout(timer)
      }
    }
  }
  return matched ? '匹配到的插件都没有处理这条命令' : `没有插件能处理“${command}”，先用 action=search 查找正确的命令格式`
}

export class YunzaiCommandTool extends CustomTool {
  name = 'yunzai_command'

  function = {
    name: 'yunzai_command',
    description: '搜索并执行机器人其他插件的命令（如原神面板、今日运势、帮助等），以当前用户的身份执行，插件的回复会直接发到聊天中。' +
      '不确定命令格式时先 search，再用 execute 执行完整命令。用户明确想使用某个机器人功能时才调用。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'execute'],
          description: 'search=按关键词查找可用命令；execute=执行一条完整命令'
        },
        query: {
          type: 'string',
          description: 'action=search 时填写，命令关键词，如“面板”“运势”“帮助”'
        },
        command: {
          type: 'string',
          description: 'action=execute 时填写，完整的单行命令，如“#刻晴面板”“#今日运势”'
        }
      },
      required: ['action']
    }
  }

  async run (args, context) {
    const e = context?.getEvent?.()
    if (typeof e?.reply !== 'function') return '当前没有可用的聊天消息，无法执行命令'
    const loader = await getLoader()
    if (!loader) return '无法访问 Yunzai 插件加载器'

    if (args.action === 'search') {
      const query = String(args.query || '').trim()
      if (!query || query.length > 40 || /[\r\n]/.test(query)) return 'query 必须是 40 字以内的单行关键词'
      return search(loader, e, query)
    }
    if (args.action === 'execute') {
      const command = String(args.command || '').trim()
      if (!command || command.length > 160 || /[\r\n]/.test(command)) return 'command 必须是 160 字以内的单行命令'
      return await execute(loader, e, command)
    }
    return 'action 只能是 search 或 execute'
  }
}

export default new YunzaiCommandTool()
