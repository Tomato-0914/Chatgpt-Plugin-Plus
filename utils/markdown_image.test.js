import assert from 'node:assert/strict'
import test from 'node:test'
import {
  looksLikeMarkdown, shouldRender, resolveOptions, planCuts, markdownToHtml, buildPage,
  renderMarkdownImages, renderMarkdownReplies
} from './markdown_image.js'

// 真浏览器测试：有 puppeteer / puppeteer-core 时跑，MARKDOWN_IMAGE_TEST_CHROME_PATH 指定浏览器
let puppeteer
try { puppeteer = (await import('puppeteer')).default } catch {
  try { puppeteer = (await import('puppeteer-core')).default } catch {}
}
const browserTest = puppeteer ? test : test.skip

const unofficial = { bot: { adapter: { id: 'OneBotv11', name: 'OneBotv11' } } }
const official = { bot: { adapter: { id: 'QQBot', name: 'QQBot' } } }
const long = '这是一段比较长的普通文字，用来凑够长度。'.repeat(8)

test('looksLikeMarkdown: 代码块、标题、表格直接算', () => {
  assert.equal(looksLikeMarkdown('看这个：\n```js\nconsole.log(1)\n```'), true)
  assert.equal(looksLikeMarkdown('## 小标题\n内容'), true)
  assert.equal(looksLikeMarkdown('| 名称 | 价格 |\n| --- | :---: |\n| 苹果 | 5 |'), true)
})

test('looksLikeMarkdown: 普通聊天、短加粗、#话题不算', () => {
  assert.equal(looksLikeMarkdown('好的，没问题'), false)
  assert.equal(looksLikeMarkdown('**好的** 我知道了 **嗯**'), false)
  assert.equal(looksLikeMarkdown('#今日话题 大家怎么看'), false)
  assert.equal(looksLikeMarkdown('a | b 两个都行'), false)
  assert.equal(looksLikeMarkdown(long), false)
})

test('looksLikeMarkdown: 长回复里的加粗、列表、引用', () => {
  assert.equal(looksLikeMarkdown(`${long}\n**重点一** 和 **重点二**`), true)
  assert.equal(looksLikeMarkdown(`${long}\n- **第一**\n- 第二`), true)
  assert.equal(looksLikeMarkdown(`${long}\n> 引用一\n> 引用二`), true)
  assert.equal(looksLikeMarkdown(`${long}\n- 只有\n- 列表`), false)
})

test('shouldRender: 开关、机器人范围、长度、模式', () => {
  const md = '## 标题\n内容'
  assert.equal(shouldRender(unofficial, md, {}), true)
  assert.equal(shouldRender(official, md, {}), false)
  assert.equal(shouldRender(official, md, { scope: 'all' }), true)
  assert.equal(shouldRender(unofficial, md, { enable: false }), false)
  assert.equal(shouldRender(unofficial, md, { maxLength: 3 }), false)
  assert.equal(shouldRender(unofficial, '你好', { mode: 'always' }), true)
  assert.equal(shouldRender(unofficial, long, { longText: 50 }), true)
  assert.equal(shouldRender(unofficial, '   ', { mode: 'always' }), false)
})

test('resolveOptions: 非法值用默认值', () => {
  const o = resolveOptions({ width: 99999, theme: 'pink', scope: 'x', maxLength: -1 })
  assert.equal(o.width, 640)
  assert.equal(o.theme, 'light')
  assert.equal(o.scope, 'unofficial')
  assert.equal(o.maxLength, 10000)
})

test('planCuts: 尽量切在段落之间', () => {
  assert.deepEqual(planCuts(1000, [300, 600], 2800), [[0, 1000]])
  assert.deepEqual(planCuts(5000, [1000, 2500, 2900, 4000], 2800), [[0, 2500], [2500, 5000]])
  // 没有合适的段落间隙就硬切
  assert.deepEqual(planCuts(6000, [], 2800), [[0, 2800], [2800, 5600], [5600, 6000]])
})

test('markdownToHtml: HTML 按文字显示，图片和链接不加载', async () => {
  const html = await markdownToHtml('<img src="file:///etc/passwd"><script>alert(1)</script>\n\n![猫](http://127.0.0.1/a.png)\n\n[文档](https://example.com/docs) 和 [https://a.com](https://a.com)')
  assert.ok(!/<img|<script/i.test(html))
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /🖼 猫/)
  assert.match(html, /<span class="link">文档<\/span><span class="link-url">example\.com\/docs<\/span>/)
  assert.match(html, /<span class="link">https:\/\/a\.com<\/span>(?!<span class="link-url">)/)
})

test('markdownToHtml: 代码高亮、任务列表', async () => {
  const html = await markdownToHtml('```js\nconst a = 1\n```\n\n- [ ] 待办\n- [x] 完成')
  assert.match(html, /<figcaption>js<\/figcaption>/)
  assert.match(html, /hljs-keyword/)
  assert.match(html, /⬜ 待办/)
  assert.match(html, /✅ 完成/)
})

test('buildPage: 带 CSP，禁止外部请求', () => {
  const page = buildPage('<p>x</p>', {})
  assert.match(page, /Content-Security-Policy" content="default-src 'none'/)
})

test('renderMarkdownReplies: 只换符合条件的文字，失败时退回文字', async () => {
  const fake = { getBrowser: async () => ({ newPage: async () => { throw new Error('no browser') } }), toSegment: b => ({ type: 'image', file: b }) }
  const img = { type: 'image', file: 'x' }
  const out = await renderMarkdownReplies(unofficial, ['你好', '## 标题', img], {}, fake)
  assert.deepEqual(out, ['你好', '## 标题', img])
  const disabled = await renderMarkdownReplies(unofficial, ['## 标题'], { enable: false }, fake)
  assert.deepEqual(disabled, ['## 标题'])
})

browserTest('真浏览器渲染：长内容切成多张 JPEG', async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.MARKDOWN_IMAGE_TEST_CHROME_PATH || undefined,
    args: ['--no-sandbox']
  })
  try {
    const short = await renderMarkdownImages('## 标题\n\n| a | b |\n| - | - |\n| 1 | 2 |', {}, { getBrowser: async () => browser })
    assert.equal(short.length, 1)
    assert.equal(short[0][0], 0xff) // JPEG
    const body = Array.from({ length: 120 }, (_, i) => `### 第 ${i + 1} 节\n\n${'内容'.repeat(40)}`).join('\n\n')
    const many = await renderMarkdownImages(body, {}, { getBrowser: async () => browser })
    assert.ok(many.length > 1 && many.length <= 8, `切成了 ${many.length} 张`)
    // 外部请求被 CSP 拦下：渲染不应卡住
    const ext = await renderMarkdownImages('![x](http://10.255.255.1/x.png)\n\n## 标题', {}, { getBrowser: async () => browser })
    assert.equal(ext.length, 1)
  } finally {
    await browser.close()
  }
})
