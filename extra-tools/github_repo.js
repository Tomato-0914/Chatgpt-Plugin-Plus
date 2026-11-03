import { CustomTool } from 'chaite'

const API = 'https://api.github.com'
const TIMEOUT = 15000

/** owner/repo，或 github.com 的仓库地址 */
function parseRepo (input) {
  const text = String(input ?? '').trim()
  const m = text.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/i) || text.match(/^([\w.-]+)\/([\w.-]+)$/)
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : null
}

async function gh (pathname, { raw = false } = {}) {
  const headers = { 'User-Agent': 'chatgpt-plugin', Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' }
  // 有 GITHUB_TOKEN 时带上，匿名每小时只能查 60 次
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`${API}${pathname}`, { headers, signal: AbortSignal.timeout(TIMEOUT) })
  if (res.status === 404) throw new Error('仓库不存在，或者是私有仓库')
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    throw new Error(`GitHub 接口次数用完了${reset ? `，${new Date(reset * 1000).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 后恢复` : ''}（可以在环境变量里配置 GITHUB_TOKEN）`)
  }
  if (!res.ok) throw new Error(`GitHub 接口返回 HTTP ${res.status}`)
  return raw ? await res.text() : await res.json()
}

const day = t => (t ? new Date(t).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '')
const num = n => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0))
const firstLine = s => String(s ?? '').split('\n')[0].trim()

async function commits (base, n, branch) {
  const list = await gh(`${base}/commits?per_page=${n}${branch ? `&sha=${encodeURIComponent(branch)}` : ''}`)
  return list.map(c => `- ${c.sha.slice(0, 7)} ${day(c.commit?.author?.date)} ${c.commit?.author?.name || c.author?.login || ''}：${firstLine(c.commit?.message).slice(0, 80)}`)
}

async function info (base) {
  const r = await gh(base)
  const lines = [
    `${r.full_name}${r.archived ? '（已归档）' : ''}${r.fork ? `（fork 自 ${r.parent?.full_name || '其他仓库'}）` : ''}`,
    r.description ? `简介：${r.description}` : '',
    `⭐ ${num(r.stargazers_count)}  🍴 ${num(r.forks_count)}  👀 ${num(r.subscribers_count ?? r.watchers_count)}  未关闭的 issue / PR：${r.open_issues_count}`,
    [r.language && `主要语言：${r.language}`, r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' && `许可证：${r.license.spdx_id}`, `默认分支：${r.default_branch}`].filter(Boolean).join('，'),
    r.topics?.length ? `标签：${r.topics.join('、')}` : '',
    `创建于 ${day(r.created_at)}，最近推送 ${day(r.pushed_at)}`,
    r.homepage ? `主页：${r.homepage}` : '',
    `地址：${r.html_url}`
  ]
  const [release, recent] = await Promise.all([
    gh(`${base}/releases/latest`).catch(() => null),
    commits(base, 5).catch(() => [])
  ])
  if (release?.tag_name) lines.push(`最新发布：${release.tag_name}${release.name && release.name !== release.tag_name ? `（${release.name}）` : ''}，${day(release.published_at)}`)
  if (recent.length) lines.push('最近的提交：', ...recent)
  return lines.filter(Boolean).join('\n')
}

export class GithubRepoTool extends CustomTool {
  name = 'github_repo'

  function = {
    name: 'github_repo',
    description: '查询 GitHub 公开仓库：基本信息（info：简介、星标、fork、语言、许可证、最新发布、最近的提交）、提交记录（commits）、' +
      '发布版本（releases）、README 内容（readme）、未关闭的 issue（issues）。用户发了 GitHub 仓库链接或问某个开源项目时调用。',
    parameters: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: '仓库，写 owner/repo 或 GitHub 仓库地址，如 https://github.com/user/repo'
        },
        action: {
          type: 'string',
          enum: ['info', 'commits', 'releases', 'readme', 'issues'],
          description: 'info=基本信息（默认）；commits=提交记录；releases=发布版本；readme=README 内容；issues=未关闭的 issue'
        },
        count: {
          type: 'number',
          description: 'commits / releases / issues 列几条，默认 10，最多 30'
        },
        branch: {
          type: 'string',
          description: 'commits 时的分支，不填为默认分支'
        }
      },
      required: ['repo']
    }
  }

  async run (args) {
    const r = parseRepo(args.repo)
    if (!r) return '仓库格式不对，请写 owner/repo 或 GitHub 仓库地址'
    const base = `/repos/${r.owner}/${r.repo}`
    const n = Math.min(Math.max(Math.floor(Number(args.count) || 10), 1), 30)
    try {
      switch (args.action || 'info') {
        case 'info':
          return await info(base)
        case 'commits': {
          const list = await commits(base, n, String(args.branch ?? '').trim())
          return list.length ? `${r.owner}/${r.repo} 最近 ${list.length} 次提交：\n${list.join('\n')}` : '没有提交记录'
        }
        case 'releases': {
          const list = await gh(`${base}/releases?per_page=${n}`)
          if (!list.length) return '这个仓库没有发布版本'
          return `${r.owner}/${r.repo} 的发布版本：\n${list.map(x => `- ${x.tag_name}${x.prerelease ? '（预发布）' : ''} ${day(x.published_at)}${x.name && x.name !== x.tag_name ? ` ${x.name}` : ''}${x.body ? `：${firstLine(x.body).slice(0, 80)}` : ''}`).join('\n')}`
        }
        case 'readme': {
          const text = await gh(`${base}/readme`, { raw: true })
          return text.length > 4000 ? `${text.slice(0, 4000)}\n……（README 共 ${text.length} 字，只显示前 4000 字）` : text
        }
        case 'issues': {
          const list = (await gh(`${base}/issues?state=open&per_page=${n}`)).filter(i => !i.pull_request)
          if (!list.length) return '没有未关闭的 issue'
          return `${r.owner}/${r.repo} 未关闭的 issue：\n${list.map(i => `- #${i.number} ${i.title}（${i.user?.login || ''}，${day(i.created_at)}，${i.comments} 条评论）`).join('\n')}`
        }
        default:
          return 'action 不正确'
      }
    } catch (err) {
      return `查询失败：${err.message}`
    }
  }
}

export default new GithubRepoTool()
