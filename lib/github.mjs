/**
 * Minimal GitHub REST client for the watchtower.
 *
 * Only the four reads the poller needs, no writes. Every call reports its own
 * failure instead of throwing into the schedule: one bad repo must not stop the
 * others from being checked, and a rate limit is a normal outcome, not a crash.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const API = 'https://api.github.com'
const UA = 'dsh-repo-watch'

export const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/**
 * Resolve a token: DSH credentials refs first, then the usual environment names.
 * The value is never logged.
 * @param {string} [refName]
 * @returns {string}
 */
export function resolveToken(refName = 'GITHUB_TOKEN') {
  const fromEnv = process.env[refName] || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (fromEnv) return String(fromEnv).trim()
  try {
    const text = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
    const refs = text.split(/^refs:\s*$/m)[1] ?? ''
    for (const line of refs.split('\n')) {
      const m = /^\s+([A-Z0-9_]+):\s*(\S.*)$/.exec(line)
      if (!m) continue
      const value = m[2].trim().replace(/^['"]|['"]$/g, '')
      if (m[1] === refName || (refName === 'GITHUB_TOKEN' && m[1] === 'GH_TOKEN')) return value
    }
  } catch { /* no credentials store */ }
  return ''
}

/**
 * One authenticated GET. Returns `{ ok, data, status, error }` and never throws.
 */
export async function get(token, path, { signal } = {}) {
  try {
    const response = await fetch(`${API}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': UA,
        'x-github-api-version': '2022-11-28',
      },
      signal,
    })
    const remaining = Number(response.headers.get('x-ratelimit-remaining') ?? -1)
    if (response.status === 304) return { ok: true, data: undefined, status: 304, remaining }
    const text = await response.text()
    let data
    try { data = text ? JSON.parse(text) : undefined } catch { data = undefined }
    if (!response.ok) {
      return { ok: false, status: response.status, remaining, error: data?.message ?? `HTTP ${response.status}` }
    }
    return { ok: true, status: response.status, data, remaining }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The authenticated login, used to tell "mine" from "someone else's". */
export async function whoami(token, options) {
  const result = await get(token, '/user', options)
  return result.ok ? String(result.data?.login ?? '') : ''
}

/**
 * Notifications are the precise "someone acted toward you" feed.
 *
 * Deliberately unfiltered: `since` cuts by `updated_at`, which hides an *unread*
 * notification whose last activity is older than the watermark — exactly the
 * month-old reply this plugin exists to surface. GitHub caps the feed at 7 days,
 * so one unfiltered request per poll is both complete and cheap.
 */
export async function listNotifications(token, { since, signal } = {}) {
  const sinceParam = since ? `&since=${encodeURIComponent(new Date(since).toISOString())}` : ''
  const result = await get(token, `/notifications?all=true&per_page=100${sinceParam}`, { signal })
  return { items: Array.isArray(result.data) ? result.data : [], ...result }
}

/**
 * Newest human comment of one thread, with a short excerpt.
 *
 * `latest_comment_url` looks like the obvious source and is a trap: for an issue
 * notification it points at the **issue itself**, so reading it answers "who
 * opened this" rather than "who spoke last" — which made the first version think
 * the maintainer had answered their own report. The comments listing is the only
 * reliable source, newest first, skipping bots so a bot comment cannot hide a
 * human reply behind it.
 *
 * The excerpt matters as much as the author: a notification that only says
 * "someone replied" makes the reader open GitHub to find out what, which defeats
 * the point of pushing it into the chat.
 *
 * @param {string} token
 * @param {{ repo: string, number: number }} thread
 * @param {{ signal?: AbortSignal, excerptChars?: number }} [options]
 * @returns {Promise<{ author: string, at: number, text: string } | undefined>}
 */
export async function lastHumanComment(token, thread, { signal, excerptChars = 80 } = {}) {
  if (!thread?.repo || !thread?.number) return undefined
  const result = await get(
    token,
    `/repos/${thread.repo}/issues/${thread.number}/comments?per_page=30&sort=created&direction=desc`,
    { signal },
  )
  if (!result.ok) return undefined
  const items = Array.isArray(result.data) ? result.data : []
  for (const item of items) {
    const author = String(item?.user?.login ?? '')
    if (!author) continue
    if (/\[bot\]$|^(dependabot|renovate|github-actions|codecov|snyk-bot)$/i.test(author)) continue
    return {
      author,
      at: Date.parse(item?.created_at ?? '') || 0,
      text: excerptOf(item?.body ?? '', excerptChars),
    }
  }
  return undefined
}

/** One line of a Markdown comment, without headings, quotes, badges or HTML. */
export function excerptOf(body, limit = 80) {
  const text = String(body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*+\s]+/gm, '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1)}…`
}

/** Issues and PRs updated since a point in time. */
export async function listRepoIssues(token, repo, { since, signal } = {}) {
  const sinceParam = since ? `&since=${encodeURIComponent(new Date(since).toISOString())}` : ''
  const result = await get(
    token,
    `/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=50${sinceParam}`,
    { signal },
  )
  return { items: Array.isArray(result.data) ? result.data : [], ...result }
}

/**
 * Recently closed issues and PRs.
 *
 * Needed because the open scan can never report a closure: a thread the user
 * already resolved would otherwise sit in "waiting" forever, and the `closed`
 * branch inside the judgement would be unreachable dead code.
 */
export async function listClosedIssues(token, repo, { since, signal } = {}) {
  const sinceParam = since ? `&since=${encodeURIComponent(new Date(since).toISOString())}` : ''
  const result = await get(
    token,
    `/repos/${repo}/issues?state=closed&sort=updated&direction=desc&per_page=50${sinceParam}`,
    { signal },
  )
  return { items: Array.isArray(result.data) ? result.data : [], ...result }
}

/** Repositories the token can see, for the "no config = watch everything" path. */
export async function listOwnRepos(token, { signal } = {}) {
  const result = await get(token, '/user/repos?per_page=100&sort=updated&affiliation=owner', { signal })
  if (!result.ok) return { items: [], ...result }
  const items = Array.isArray(result.data) ? result.data : []
  return {
    ok: true,
    items: items.filter((repo) => !repo.fork && !repo.archived).map((repo) => repo.full_name),
  }
}
