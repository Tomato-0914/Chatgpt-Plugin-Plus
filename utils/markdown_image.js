/**
 * AI 回复的 Markdown 渲染成图片
 *
 * ICQQ / OneBot 等非官方机器人发不了 Markdown，AI 回复里的 **加粗**、## 标题、表格、代码块会原样显示。
 * 回复里有这些写法时，用 markdown-it 转成 HTML（代码高亮由 highlight.js 在这边做好），
 * 借云崽的浏览器开一个页面截图，替换成图片发送。
 *
 * - 不联网：页面带内容安全策略（CSP），外部图片、字体、脚本一律不加载；Markdown 里的 HTML 按文字显示
 * - Markdown 图片 ![](url) 显示成占位文字，链接显示文字和网址（图片里点不了）
 * - 太长时按段落切成几张图；超过 maxLength 字、缺依赖或渲染失败时照常发文字
 * 配置见 config/config.js 的 markdownImage。
 */
import { createSemaphore } from './concurrency.js'

export const DEFAULTS = {
  enable: true,
  scope: 'unofficial',
  mode: 'auto',
  longText: 0,
  maxLength: 10000,
  width: 640,
  theme: 'light'
}

/** 单张图片最高多少像素（CSS 像素，实际再乘清晰度倍数），超过就按段落切开 */
const PAGE_HEIGHT = 2800
/** 最多切成几张 */
const MAX_PAGES = 8
/** 清晰度倍数 */
const SCALE = 2
/** 只有加粗、列表、引用这类写法时，短于这么多字不渲染（一两句话变成图片反而难看） */
const INLINE_MIN_LENGTH = 100

const withRenderPermit = createSemaphore(() => 2)

const escapeHtml = text => String(text ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/** 合并用户配置和默认值，数值越界时用默认值 */
export function resolveOptions (config) {
  const o = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const num = (v, min, max, def) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : def
  }
  return {
    enable: o.enable !== false,
    scope: o.scope === 'all' ? 'all' : 'unofficial',
    mode: o.mode === 'always' ? 'always' : 'auto',
    longText: num(o.longText, 0, 1e6, 0),
    maxLength: num(o.maxLength, 1, 1e6, DEFAULTS.maxLength),
    width: num(o.width, 320, 1600, DEFAULTS.width),
    theme: o.theme === 'dark' ? 'dark' : 'light'
  }
}

/** 是否官方机器人（QQBot 适配器） */
export const isOfficialBot = e =>
  [e?.bot?.adapter?.id, e?.bot?.adapter?.name, e?.adapter_name, e?.adapter].some(v => v === 'QQBot')

/**
 * 文字里有没有值得渲染的 Markdown 写法：
 * 代码块、标题、表格直接算；加粗、列表、引用要文字够长（≥ 100 字）才算
 */
export function looksLikeMarkdown (text) {
  const s = String(text ?? '')
  if (/^ {0,3}(```|~~~)/m.test(s)) return true
  if (/^ {0,3}#{1,6}[ \t]+\S/m.test(s)) return true
  // 表格：表头行后面跟着 |---|---| 分隔行
  if (/^[^\n]*\|[^\n]*\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m.test(s)) return true
  if (s.length < INLINE_MIN_LENGTH) return false
  const strong = s.match(/\*\*[^*\n]+?\*\*|__[^_\n]+?__/g)?.length || 0
  const list = s.match(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+\S/gm)?.length || 0
  const quote = s.match(/^ {0,3}>[ \t]?\S/gm)?.length || 0
  return strong >= 2 || (strong >= 1 && list >= 2) || quote >= 2
}

/** 这段文字要不要渲染成图片 */
export function shouldRender (e, text, config) {
  const o = resolveOptions(config)
  const s = String(text ?? '').trim()
  if (!o.enable || !s) return false
  if (o.scope !== 'all' && isOfficialBot(e)) return false
  if (s.length > o.maxLength) return false
  if (o.mode === 'always') return true
  if (o.longText > 0 && s.length >= o.longText) return true
  return looksLikeMarkdown(s)
}

let mdPromise
let warnedMissing = false

/** markdown-it 实例（依赖缺失时抛错，由调用方回退成文字） */
function getMarkdownIt () {
  mdPromise ??= (async () => {
    const [{ default: MarkdownIt }, { default: hljs }] = await Promise.all([import('markdown-it'), import('highlight.js')])
    // html: false 让回复里的 HTML 按文字显示；breaks: true 让单个换行也换行（聊天习惯）
    const md = new MarkdownIt({ html: false, breaks: true, linkify: false, typographer: false })

    const highlight = (code, lang) => {
      try {
        if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
        // 没写语言的短代码自动识别，长的直接显示，免得识别太慢
        if (code.length <= 5000) return hljs.highlightAuto(code).value
      } catch {}
      return escapeHtml(code)
    }

    md.renderer.rules.fence = (tokens, idx) => {
      const token = tokens[idx]
      const lang = String(token.info || '').trim().split(/\s+/)[0]
      const head = lang ? `<figcaption>${escapeHtml(lang)}</figcaption>` : ''
      return `<figure class="code">${head}<pre><code class="hljs">${highlight(token.content.replace(/\n$/, ''), lang)}</code></pre></figure>\n`
    }
    md.renderer.rules.code_block = (tokens, idx) =>
      `<figure class="code"><pre><code class="hljs">${escapeHtml(tokens[idx].content.replace(/\n$/, ''))}</code></pre></figure>\n`

    // 图片不加载，显示占位文字
    md.renderer.rules.image = (tokens, idx) => {
      const alt = tokens[idx].children?.map(t => t.content).join('') || tokens[idx].content
      return `<span class="img">🖼 ${escapeHtml(alt || '图片')}</span>`
    }

    // 链接点不了：显示文字，文字不是网址本身时后面附上简短网址
    md.renderer.rules.link_open = () => '<span class="link">'
    md.renderer.rules.link_close = (tokens, idx) => {
      let depth = 0
      let j = idx
      while (--j >= 0) {
        if (tokens[j].type === 'link_close') depth++
        else if (tokens[j].type === 'link_open' && depth-- === 0) break
      }
      const href = j >= 0 ? tokens[j].attrGet('href') || '' : ''
      const text = tokens.slice(j + 1, idx).map(t => t.content).join('').trim()
      const bare = href.replace(/^(https?:\/\/|mailto:)/i, '').replace(/\/$/, '')
      if (!href || text === href || text.replace(/\/$/, '') === bare) return '</span>'
      const short = bare.length > 48 ? `${bare.slice(0, 45)}…` : bare
      return `</span><span class="link-url">${escapeHtml(short)}</span>`
    }
    return md
  })()
  return mdPromise
}

/** Markdown 转成 HTML 片段 */
export async function markdownToHtml (text) {
  const md = await getMarkdownIt()
  return md.render(String(text ?? ''))
    // 任务列表 - [ ] / - [x]
    .replace(/<li>(<p>)?\[ \]\s/g, '<li class="task">$1⬜ ')
    .replace(/<li>(<p>)?\[[xX]\]\s/g, '<li class="task">$1✅ ')
}

const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", "Segoe UI", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"'
const MONO = '"JetBrains Mono", "Cascadia Code", "Fira Code", Consolas, Menlo, "Noto Sans Mono CJK SC", "Microsoft YaHei", monospace'

const THEMES = {
  light: {
    page: '#eef0f3',
    card: '#ffffff',
    border: '#e3e6ea',
    text: '#1f2328',
    soft: '#59636e',
    heading: '#111418',
    accent: '#2f6feb',
    inline: '#eff1f4',
    inlineText: '#b42359',
    tableHead: '#f5f7f9',
    tableStripe: '#fafbfc',
    quote: '#f6f8fa',
    shadow: '0 2px 12px rgba(31,35,40,.06)'
  },
  dark: {
    page: '#0b0e13',
    card: '#151a21',
    border: '#2a313b',
    text: '#dfe6ee',
    soft: '#9aa6b2',
    heading: '#f2f5f8',
    accent: '#6ea8ff',
    inline: '#222a34',
    inlineText: '#ff9ac1',
    tableHead: '#1c232c',
    tableStripe: '#181e26',
    quote: '#1a2028',
    shadow: '0 2px 12px rgba(0,0,0,.35)'
  }
}

/** 完整页面 */
export function buildPage (bodyHtml, config) {
  const o = resolveOptions(config)
  const t = THEMES[o.theme]
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: ${t.page}; }
body { width: ${o.width + 32}px; padding: 16px; font: 17px/1.75 ${FONT}; color: ${t.text}; -webkit-font-smoothing: antialiased; }
.card { background: ${t.card}; border: 1px solid ${t.border}; border-radius: 14px; padding: 22px 26px; box-shadow: ${t.shadow}; }
.md { overflow-wrap: anywhere; word-break: break-word; }
.md > :first-child { margin-top: 0 !important; }
.md > :last-child { margin-bottom: 0 !important; }
.md p { margin: 0 0 12px; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { color: ${t.heading}; line-height: 1.35; margin: 22px 0 10px; font-weight: 650; }
.md h1 { font-size: 1.5em; padding-bottom: 8px; border-bottom: 1px solid ${t.border}; }
.md h2 { font-size: 1.3em; padding-left: 10px; border-left: 4px solid ${t.accent}; }
.md h3 { font-size: 1.15em; }
.md h4, .md h5, .md h6 { font-size: 1em; }
.md strong { color: ${t.heading}; font-weight: 650; }
.md ul, .md ol { margin: 0 0 12px; padding-left: 1.6em; }
.md li { margin: 3px 0; }
.md li > p { margin: 0 0 4px; }
.md li > ul, .md li > ol { margin: 2px 0 4px; }
.md li.task { list-style: none; margin-left: -1.2em; }
.md hr { border: 0; height: 1px; background: ${t.border}; margin: 18px 0; }
.md blockquote { margin: 0 0 12px; padding: 8px 14px; color: ${t.soft}; background: ${t.quote}; border-left: 4px solid ${t.border}; border-radius: 0 8px 8px 0; }
.md blockquote > :last-child { margin-bottom: 0; }
.md code { font: 0.88em ${MONO}; font-variant-ligatures: none; background: ${t.inline}; color: ${t.inlineText}; padding: 0.15em 0.4em; border-radius: 5px; }
.md .link { color: ${t.accent}; }
.md .link-url { color: ${t.soft}; font-size: 0.8em; margin-left: 4px; }
.md .link-url::before { content: "("; } .md .link-url::after { content: ")"; }
.md .img { display: inline-block; color: ${t.soft}; background: ${t.inline}; padding: 0 8px; border-radius: 5px; font-size: 0.9em; }
.md table { border-collapse: separate; border-spacing: 0; margin: 0 0 14px; width: 100%; font-size: 0.92em; border: 1px solid ${t.border}; border-radius: 8px; overflow: hidden; }
.md th, .md td { padding: 7px 11px; border-bottom: 1px solid ${t.border}; border-right: 1px solid ${t.border}; text-align: left; vertical-align: top; }
.md th:last-child, .md td:last-child { border-right: 0; }
.md tr:last-child td { border-bottom: 0; }
.md th { background: ${t.tableHead}; color: ${t.heading}; font-weight: 650; }
.md tbody tr:nth-child(even) td { background: ${t.tableStripe}; }
.md figure.code { margin: 0 0 14px; border-radius: 10px; overflow: hidden; background: #0f141b; border: 1px solid ${o.theme === 'dark' ? t.border : '#0f141b'}; }
.md figure.code figcaption { font: 12px/1 ${MONO}; color: #8b97a5; padding: 9px 14px 0; text-transform: lowercase; }
.md pre { margin: 0; padding: 12px 14px 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.md pre code { font: 14px/1.6 ${MONO}; font-variant-ligatures: none; background: none; color: #d6deeb; padding: 0; border-radius: 0; }
.hljs-comment, .hljs-quote { color: #7d8a99; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-type, .hljs-doctag { color: #ff7b9c; }
.hljs-string, .hljs-regexp, .hljs-addition, .hljs-attribute, .hljs-template-tag { color: #a5e07a; }
.hljs-number, .hljs-symbol, .hljs-bullet, .hljs-variable.constant_ { color: #f7b267; }
.hljs-title, .hljs-title.function_, .hljs-section, .hljs-selector-id { color: #6fc1ff; }
.hljs-title.class_, .hljs-built_in, .hljs-name { color: #c7a4ff; }
.hljs-attr, .hljs-property, .hljs-params, .hljs-variable, .hljs-selector-class { color: #9cdcfe; }
.hljs-meta, .hljs-meta .hljs-keyword { color: #79c0ff; }
.hljs-deletion { color: #ff8f8f; }
.hljs-emphasis { font-style: italic; } .hljs-strong { font-weight: 700; }
</style></head>
<body><main class="card"><article class="md">${bodyHtml}</article></main></body></html>`
}

/** 云崽配置的浏览器（和 utils/image_size.js 一样的取法，懒加载，不用时不启动渲染器） */
async function yunzaiBrowser () {
  const { default: hostRenderer } = await import('../../../lib/puppeteer/puppeteer.js')
  let renderer = hostRenderer?.renderers?.get('puppeteer') || hostRenderer
  if (!renderer?.browser && typeof renderer?.browserInit !== 'function') {
    const { default: loader } = await import('../../../lib/renderer/loader.js')
    renderer = loader.getRenderer('puppeteer')
  }
  for (let i = 0; renderer.lock && !renderer.browser && i < 300; i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const browser = renderer.browser || await renderer.browserInit?.()
  if (!browser?.newPage) throw new Error('云崽 Puppeteer 浏览器不可用，请检查截图功能')
  return browser
}

/**
 * 切图位置：每张不超过 pageHeight，尽量切在段落之间；单个段落太高时硬切
 * @param {number} total 页面总高度
 * @param {number[]} gaps 可以下刀的位置（段落之间）
 */
export function planCuts (total, gaps, pageHeight = PAGE_HEIGHT) {
  const cuts = []
  let start = 0
  while (total - start > pageHeight) {
    const limit = start + pageHeight
    // 至少留三分之一页，免得切出很矮的一张
    const candidates = gaps.filter(g => g > start + pageHeight / 3 && g <= limit)
    const cut = candidates.length ? Math.max(...candidates) : limit
    cuts.push([start, cut])
    start = cut
  }
  cuts.push([start, total])
  return cuts
}

/**
 * Markdown 渲染成图片
 * @returns {Promise<Buffer[]>} 一张或几张 JPEG
 */
export async function renderMarkdownImages (text, config, { getBrowser = yunzaiBrowser } = {}) {
  const html = buildPage(await markdownToHtml(text), config)
  const { width } = resolveOptions(config)
  return withRenderPermit(async () => {
    const browser = await getBrowser()
    const page = await browser.newPage()
    let timer
    try {
      const work = (async () => {
        await page.setViewport({ width: width + 32, height: 800, deviceScaleFactor: SCALE })
        await page.setContent(html, { waitUntil: 'load', timeout: 15000 })
        const { total, gaps } = await page.evaluate(() => {
          const blocks = [...document.querySelectorAll('.md > *')]
          const gaps = []
          for (let i = 1; i < blocks.length; i++) {
            const prev = blocks[i - 1].getBoundingClientRect().bottom
            const next = blocks[i].getBoundingClientRect().top
            gaps.push(Math.round((prev + next) / 2))
          }
          return { total: Math.ceil(document.documentElement.scrollHeight), gaps }
        })
        const cuts = planCuts(total, gaps)
        if (cuts.length > MAX_PAGES) throw new Error(`内容太长（需要 ${cuts.length} 张图）`)
        const images = []
        for (const [y, end] of cuts) {
          const shot = await page.screenshot({
            type: 'jpeg',
            quality: 90,
            clip: { x: 0, y, width: width + 32, height: end - y },
            captureBeyondViewport: true
          })
          images.push(Buffer.from(shot))
        }
        return images
      })()
      return await Promise.race([
        work,
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('渲染超时')), 30000) })
      ])
    } finally {
      clearTimeout(timer)
      await page.close().catch(() => {})
    }
  })
}

/**
 * 处理一组待发送的消息：符合条件的文字换成渲染好的图片，其余原样保留
 * @param {*} e 云崽消息事件
 * @param {Array<string|object>} msgs toYunzai 转换后的消息
 * @param {*} config Config.markdownImage
 */
export async function renderMarkdownReplies (e, msgs, config, deps = {}) {
  if (!Array.isArray(msgs) || !resolveOptions(config).enable) return msgs
  const out = []
  for (const msg of msgs) {
    if (typeof msg !== 'string' || !shouldRender(e, msg, config)) {
      out.push(msg)
      continue
    }
    try {
      const images = await renderMarkdownImages(msg, config, deps)
      const image = deps.toSegment || (buf => globalThis.segment.image(buf))
      out.push(...images.map(image))
    } catch (err) {
      const missing = err?.code === 'ERR_MODULE_NOT_FOUND' && /markdown-it|highlight\.js/.test(err.message)
      if (missing) {
        if (!warnedMissing) {
          warnedMissing = true
          globalThis.logger?.warn?.('[Markdown 图片] 缺少依赖 markdown-it / highlight.js，回复按文字发送。请在插件目录执行 pnpm install 后重启')
        }
        mdPromise = undefined
      } else {
        globalThis.logger?.warn?.(`[Markdown 图片] 渲染失败，按文字发送：${err?.message || err}`)
      }
      out.push(msg)
    }
  }
  return out
}
