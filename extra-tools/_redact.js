/**
 * 文字脱敏：把密钥、令牌、密码等敏感值替换成 ***，用于 shell 输出、读取框架文件等会把内容交给 AI 或发到群里的场景
 *
 * 规则偏保守，只处理两类：
 *   1. 键名像敏感字段的键值对（yaml、json、ini、env、命令行参数），只隐藏值，保留键名和结构
 *   2. 格式固定、一眼能认出来的密钥（sk-...、ghp_...、私钥块、Bearer 令牌、带密码的连接地址等）
 * 以 _ 开头，不会被当成工具登记。
 */

const MASK = '***'

/** 键名里带这些词就当作敏感字段 */
const SENSITIVE_KEY = /pass(word|wd)?|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|cookie|authorization|credential|session|signature|sign[-_]?key|ticket|authkey|refresh/i

/** 值是否像普通配置而不是密钥：空、占位、布尔、短数字 */
const harmless = value => !value || /^(true|false|null|none|undefined|~|\d{1,6})$/i.test(value)

const PATTERNS = [
  // PEM 私钥块
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, `-----BEGIN PRIVATE KEY----- ${MASK} -----END PRIVATE KEY-----`],
  // 常见服务的密钥前缀
  [/\b(sk-proj|sk-ant|sk|rk|pk_live|sk_live)-[A-Za-z0-9_-]{16,}/g, (m, p) => `${p}-${MASK}`],
  [/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, (m, p) => `${p}_${MASK}`],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, `xox-${MASK}`],
  [/\bAKIA[0-9A-Z]{16}\b/g, `AKIA${MASK}`],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, `AIza${MASK}`],
  // Authorization: Bearer xxx
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, (m, type) => `${type} ${MASK}`],
  // 连接地址里的密码：scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, (m, head) => `${head}:${MASK}@`]
]

/**
 * yaml / env / ini 逐行处理：
 *   key: value、KEY=value（值没有引号）只隐藏值；
 *   敏感键名下面的 yaml 列表或子项（如 token:\n  - xxx）整块隐藏
 */
function redactLines (text) {
  let block = null // 正在隐藏的敏感键所在的缩进
  return text.split('\n').map(line => {
    const indent = line.match(/^\s*/)[0].length
    if (block !== null) {
      const item = /^\s*-\s/.test(line)
      if (line.trim() && (indent > block || (item && indent === block))) {
        return line.replace(/^(\s*(?:-\s+)?)(?:([\w.-]+\s*:\s*))?.*$/, (m, lead, key = '') => `${lead}${key}${MASK}`)
      }
      if (line.trim()) block = null
    }
    const m = line.match(/^(\s*(?:-\s+)?(?:export\s+)?)([\w.-]+)([ \t]*[:=][ \t]*)(.*?)([ \t]+#.*)?$/)
    if (!m || !SENSITIVE_KEY.test(m[2])) return line
    const [, lead, key, sep, value, comment = ''] = m
    if (!value.trim()) {
      // 值在下面几行（yaml 列表 / 子项）
      if (sep.includes(':')) block = indent
      return line
    }
    if (/^["']/.test(value) || harmless(value.trim())) return line
    return `${lead}${key}${sep}${MASK}${comment}`
  }).join('\n')
}

export function redact (text) {
  let out = String(text ?? '')
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)

  // JSON / JS："key": "value"、'key': 'value'、key: "value"
  out = out.replace(/(["']?)([\w.-]+)\1(\s*:\s*)(["'])((?:\\.|(?!\4)[^\n])*)\4/g, (m, q, key, sep, vq, value) =>
    SENSITIVE_KEY.test(key) && !harmless(value) ? `${q}${key}${q}${sep}${vq}${MASK}${vq}` : m)

  out = redactLines(out)

  // 命令行参数：--password xxx、--token=xxx
  out = out.replace(/(--?[\w-]*(?:pass(?:word)?|token|secret|apikey|api-key)[\w-]*)(=|\s+)(?!-)(\S+)/gi, (m, flag, sep) => `${flag}${sep}${MASK}`)
  return out
}
