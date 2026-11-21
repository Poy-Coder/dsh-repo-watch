/**
 * dsh-repo-watch — a repository watchtower for DSH.
 *
 * The premise: a maintainer does not open GitHub on a schedule, so anything that
 * only exists inside a notification list is effectively invisible. This plugin
 * polls in the background, keeps its own state, and speaks only when a thread
 * *enters* the state "someone is waiting on you".
 *
 * Design notes that matter more than the code:
 *   - GitHub's read flag is not used. Opening a notification marks it read and
 *     loses it forever (the problem octobox exists to solve), so the plugin keeps
 *     its own pending/seen/done state in `~/.dsh/repo-watch.json`.
 *   - Decisions live in `lib/triage.mjs` as pure functions; this file only wires
 *     them to the network, a timer, and the chat channel.
 *   - It never writes to GitHub. No comment, no label, no close.
 */
import { setTimeout as delay } from 'node:timers/promises'

import z from '@deepseek-ai/schemastery'

import { excerptOf, lastHumanComment, listClosedIssues, listNotifications, listOwnRepos, listRepoIssues, resolveToken, whoami } from './lib/github.mjs'
import { countsOf, loadState, pruneThreads, saveState, statePath, upsertThread } from './lib/state.mjs'
import { classify, priorityOf, progressOf, similarTo } from './lib/insight.mjs'
import { logRecord } from './lib/log.mjs'
import { bucketHint, bucketOf, bucketText, closureTargets, inQuietHours, isBotLogin, judgeNotification, judgeRepoItem, reasonText, shouldNotify, threadOf } from './lib/triage.mjs'

export const name = 'repo-watch'

/**
 * `tools` is a hard dependency: the plugin's whole surface is four tools, and
 * reaching for `ctx.tools` without declaring it fails activation with
 * "cannot get property \"tools\" without inject".
 */
export const inject = ['tools']

export const Config = z.object({
  repos: z.array(z.string()).default([])
    .description('Repositories to watch ("owner/name"). Empty discovers every non-fork repo the token owns.'),
  pollMinutes: z.number().default(15).description('How often the background poll runs.'),
  notify: z.boolean().default(true).description('Send "someone is waiting" messages to the chat. Off = local state only.'),
  pushTool: z.string().default('')
    .description('Tool used to deliver a message (e.g. feishu_send_message). Empty picks the first *_send_message on this DSH.'),
  quietHours: z.string().default('23-8')
    .description('Local hours with no messages, "23-8". Anything arriving then is folded into the next daytime message.'),
  maxP0PerHour: z.number().default(1).description('At most this many "waiting" messages per hour; extra ones merge.'),
  backfillDays: z.number().default(30).description('First run only: how far back to look so the state file starts informed.'),
  tokenEnv: z.string().default('GITHUB_TOKEN').description('Credential reference holding the GitHub token.'),
  muteBots: z.boolean().default(true).description('Ignore bot accounts ([bot], dependabot, github-actions…).'),
  stateFile: z.string().default('').description('Override the state path (defaults to ~/.dsh/repo-watch.json).'),
})

const oneHour = 60 * 60 * 1000

/** Mutable per-process view of the schedule; a reload rebuilds it from the state file. */
const runtime = {
  ready: false,
  lastPollAt: 0,
  lastPollError: '',
  lastPushAt: 0,
  pushesThisHour: 0,
  hourStartedAt: 0,
  token: '',
  me: '',
  repos: [],
  pendingQueue: [],
}

const errorText = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Deliver one piece of text through whatever channel this DSH already has.
 *
 * Reuses the installed IM channel plugin instead of shipping its own transport:
 * the user configured that chat once, and there is no reason to ask twice.
 * Resolved at call time so a disabled channel degrades to "log only".
 */
async function pushText(ctx, config, text) {
  if (config?.notify === false) return { ok: false, reason: 'notify-disabled' }
  const now = Date.now()
  if (now - runtime.hourStartedAt > oneHour) {
    runtime.hourStartedAt = now
    runtime.pushesThisHour = 0
  }
  const limit = Math.max(1, Number(config?.maxP0PerHour ?? 1))
  if (runtime.pushesThisHour >= limit) return { ok: false, reason: 'hourly-limit' }

  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (!tools || typeof tools.execute !== 'function') return { ok: false, reason: 'no-tools' }
  let names = []
  try {
    names = tools.definitions().map((definition) => String(definition?.name ?? ''))
  } catch { /* registry unavailable */ }
  const senders = names.filter((toolName) => /_send_message$/.test(toolName))
  const preferred = String(config?.pushTool ?? '').trim()
  const target = preferred && senders.includes(preferred) ? preferred : senders[0]
  if (!target) return { ok: false, reason: 'no-channel' }

  try {
    const batch = await tools.execute({
      calls: [{
        type: 'tool-call',
        id: `repo-watch-${now}`,
        name: target,
        arguments: JSON.stringify({ text }),
      }],
      signal: AbortSignal.timeout(25_000),
    })
    const first = Array.isArray(batch?.results) ? batch.results[0] : undefined
    if (first?.isError) return { ok: false, reason: `tool-error: ${target}` }
    runtime.pushesThisHour += 1
    runtime.lastPushAt = now
    // Log the delivery, not just the attempt: "why did I get no push" is only
    // answerable if a successful send leaves a record.
    logRecord({ event: 'push', result: 'sent', level: 'info', tool: target, chars: String(text ?? '').length })
    return { ok: true, tool: target }
  } catch (error) {
    return { ok: false, reason: `dispatch-failed: ${errorText(error)}` }
  }
}

/** "2026-10-16" as "10-16", and today's as "今天". */
function shortDay(at) {
  const value = Number(at)
  if (!value) return ''
  const date = new Date(value)
  const today = new Date()
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  if (sameDay) return '今天'
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${mm}-${dd}`
}

/**
 * The one message this plugin sends.
 *
 * It is a roll-call, not a dump. Listing every thread with its excerpt felt wrong
 * in practice: a push is read on a phone in two seconds, and four paragraphs of
 * somebody else's comment is more than that moment can absorb. So the message says
 * how many there are, where they come from, split by what they want from you, and
 * how to ask for the detail — which is one reply away, in the same chat.
 *
 * Plain text by design: no emoji, no decoration. The wording says 查看 rather than
 * 看 because a one-character prompt reads like a typo, even though short replies
 * are exactly what the digest accepts.
 */
function composeWaitingMessage(entries) {
  const buckets = { reply: [], action: [], other: [] }
  for (const entry of entries) buckets[bucketOf(entry.reason)].push(entry)
  const total = entries.length
  const head = `有 ${total} 条新消息（来源：GitHub）`
  const lines = [head, '']
  for (const key of ['reply', 'action', 'other']) {
    const count = buckets[key].length
    if (count === 0) continue
    lines.push(`· ${bucketText(key)} ${count} 条 — ${bucketHint(key)}`)
  }
  lines.push('')
  const hints = ['回复「查看」查看全部明细']
  if (buckets.reply.length) hints.push('「查看 1」只看需要你回复的')
  if (buckets.action.length) hints.push('「查看 2」只看需要你处理的')
  lines.push(`${hints.join('；')}。`)
  const newest = entries
    .slice()
    .sort((a, b) => Number(b.lastActivityAt ?? 0) - Number(a.lastActivityAt ?? 0))[0]
  if (newest) {
    const kind = String(newest.thread?.kind ?? newest.kind ?? '')
    const kindText = kind === 'pr' ? '（PR）' : kind === 'issue' ? '（issue）' : ''
    const title = newest.title ? `　${newest.title}` : ''
    lines.push(`最近一条：${newest.key}${title}${kindText}`)
  }
  return lines.join('\n')
}

/**
 * Fold newly noticed activity into the stored list.
 *
 * One entry per thread (the newest wins), bounded, and pruned by age: this list
 * exists so "what else moved" can be answered, not as an archive.
 */
function mergeActivity(previous, noticed, now) {
  const byKey = new Map()
  for (const item of Array.isArray(previous) ? previous : []) {
    if (item?.key) byKey.set(item.key, item)
  }
  for (const item of noticed) {
    const existing = byKey.get(item.key)
    if (!existing || Number(item.at ?? 0) >= Number(existing.at ?? 0)) byKey.set(item.key, item)
  }
  const keepMs = 30 * 24 * 60 * 60 * 1000
  return [...byKey.values()]
    .filter((item) => now - Number(item.at ?? 0) <= keepMs)
    .sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))
    .slice(0, 200)
}

/**
 * One poll: notifications (someone acted toward me) + repo scan (someone opened
 * something of mine). Both paths feed the same judgement and the same state file.
 */
async function pollOnce(ctx, config) {
  const token = runtime.token || resolveToken(config?.tokenEnv)
  if (!token) {
    runtime.lastPollError = 'no GitHub token (credentials refs GITHUB_TOKEN, or GH_TOKEN)'
    return { ok: false, reason: 'no-token' }
  }
  runtime.token = token
  if (!runtime.me) runtime.me = await whoami(token)
  if (!runtime.me) {
    runtime.lastPollError = 'token rejected by /user'
    return { ok: false, reason: 'bad-token' }
  }
  let repos = Array.isArray(config?.repos) ? config.repos.filter(Boolean) : []
  if (repos.length === 0) {
    if (runtime.repos.length === 0) runtime.repos = (await listOwnRepos(token)).items
    repos = runtime.repos
  }

  const state = loadState(config ?? {})
  const now = Date.now()
  const backfill = Math.max(1, Number(config?.backfillDays ?? 30)) * 24 * 60 * 60 * 1000
  const since = state.watermark > 0 ? state.watermark : now - backfill

  const candidates = []
  const failures = []

  const notifications = await listNotifications(token, {})
  if (!notifications.ok) failures.push(`notifications: ${notifications.error ?? notifications.status}`)
  for (const notification of notifications.items) {
    const thread = threadOf(notification?.subject?.url ?? notification?.subject?.latest_comment_url)
    if (!thread) continue
    let actor = ''
    let snippet = ''
    let spokeAt = 0
    const reason = String(notification.reason ?? '')
    if (reason === 'author' || reason === 'comment') {
      const last = await lastHumanComment(token, thread, {})
      actor = String(last?.author ?? '')
      snippet = String(last?.text ?? '')
      spokeAt = Number(last?.at ?? 0)
    }
    // Mute bots by who spoke, not by what the title looks like: the first version
    // tested the subject title for a "[bot]" suffix, which never matched the actor.
    if (config?.muteBots !== false && actor && isBotLogin(actor)) continue
    const verdict = judgeNotification({ notification, me: runtime.me, lastActor: actor })
    candidates.push({
      key: thread.key, thread, actor, snippet, spokeAt, verdict,
      title: String(notification?.subject?.title ?? ''),
      url: `https://github.com/${thread.repo}/${thread.kind === 'pr' ? 'pull' : 'issues'}/${thread.number}`,
      lastActivityAt: spokeAt || Date.parse(notification?.updated_at ?? '') || now,
    })
  }

  for (const repo of repos) {
    const result = await listRepoIssues(token, repo, { since })
    if (!result.ok) { failures.push(`${repo}: ${result.error ?? result.status}`); continue }
    for (const issue of result.items) {
      const thread = threadOf(issue?.url)
      if (!thread) continue
      const verdict = judgeRepoItem({ issue, me: runtime.me })
      candidates.push({
        key: thread.key, thread, actor: String(issue?.user?.login ?? ''), verdict,
        snippet: excerptOf(issue?.body ?? ''),
        spokeAt: Date.parse(issue?.created_at ?? '') || 0,
        title: String(issue?.title ?? ''),
        url: String(issue?.html_url ?? ''),
        lastActivityAt: Date.parse(issue?.updated_at ?? '') || now,
      })
    }
  }

  const fresh = []
  const noticed = []
  for (const candidate of candidates) {
    if (!candidate.verdict.pending) {
      // Activity that does not need an answer is still activity: it is what the
      // "quiet" digest is for, and throwing it away would make that digest empty.
      if (!/^(i-spoke-last|already-read|closed|mine)$/.test(candidate.verdict.reason)) {
        noticed.push({
          key: candidate.key,
          title: candidate.title,
          actor: candidate.actor,
          text: candidate.snippet,
          reason: candidate.verdict.reason,
          at: candidate.lastActivityAt,
        })
      }
      continue
    }
    const previous = state.threads[candidate.key]
    const notify = shouldNotify({
      previous: previous?.state,
      pending: true,
      lastActivityAt: candidate.lastActivityAt,
      stateSince: Number(previous?.stateSince ?? 0),
      snoozeUntil: Number(previous?.snoozeUntil ?? 0),
      now,
    })
    upsertThread(state, candidate.key, {
      kind: candidate.thread.kind,
      title: candidate.title,
      lastActor: candidate.actor,
      lastText: candidate.snippet,
      lastActivityAt: candidate.lastActivityAt,
      reason: candidate.verdict.reason,
      url: candidate.url,
    }, { pending: true, notify })
    if (notify) fresh.push({ ...candidate, reason: candidate.verdict.reason })
  }

  // A closure is the one transition the open scan cannot see: settle those threads
  // so a resolved report stops asking for attention.
  const closed = []
  for (const repo of repos) {
    const result = await listClosedIssues(token, repo, { since })
    if (!result.ok && result.status !== 304) { failures.push(`closed ${repo}: ${result.error ?? result.status}`); continue }
    for (const key of closureTargets({ items: result.items, threads: state.threads })) {
      const thread = state.threads[key]
      thread.state = 'done'
      thread.stateSince = now
      thread.snoozeUntil = 0
      thread.resolvedBy = 'closed'
      closed.push(key)
      logRecord({ event: 'inbound', result: 'settled-by-closure', level: 'info', thread: key })
    }
  }

  state.activity = mergeActivity(state.activity, noticed, now)
  state.watermark = now
  pruneThreads(state, now)
  saveState(config ?? {}, state)

  runtime.lastPollAt = now
  runtime.lastPollError = failures.join('; ')

  if (fresh.length > 0 && config?.notify !== false) runtime.pendingQueue.push(...fresh)
  return { ok: true, scanned: candidates.length, fresh: fresh.length, closed: closed.length, failures }
}

/** Flush queued "waiting" items, respecting the quiet window. */
async function flushQueue(ctx, config) {
  if (runtime.pendingQueue.length === 0) return
  const hour = new Date().getHours()
  if (inQuietHours(hour, config?.quietHours)) return
  const entries = runtime.pendingQueue.splice(0, runtime.pendingQueue.length)
  const sent = await pushText(ctx, config, composeWaitingMessage(entries))
  if (!sent.ok) logRecord({ event: 'push', result: 'skipped', level: 'warn', reason: sent.reason, count: entries.length })
  if (!sent.ok) runtime.pendingQueue.unshift(...entries)
}


export function apply(ctx, config) {
  ctx.tools.register(statusTool(config))
  ctx.tools.register(digestTool(config))
  ctx.tools.register(ackTool(config))
  ctx.tools.register(checkTool(ctx, config))

  ctx.effect(() => {
    let disposed = false
    const minutes = Math.max(1, Number(config?.pollMinutes ?? 15))
    const tick = async () => {
      if (disposed) return
      try {
        await pollOnce(ctx, config)
        await flushQueue(ctx, config)
      } catch (error) {
        runtime.lastPollError = errorText(error)
      }
    }
    // Startup is deferred so plugin activation stays fast and a slow network
    // never delays the rest of the profile.
    const kickoff = setTimeout(() => { void tick() }, 20_000)
    kickoff.unref?.()
    const timer = setInterval(() => { void tick() }, minutes * 60_000)
    timer.unref?.()
    return () => {
      disposed = true
      clearTimeout(kickoff)
      clearInterval(timer)
    }
  }, 'dsh-repo-watch: poller')
}

const statusTool = (config) => ({
  name: 'repo_watch_status',
  description:
    'Report the repository watchtower state: how many threads are pending/seen/done, '
    + 'which repositories are watched, when the last poll ran, and what failed if anything did. '
    + 'Use it before answering questions about GitHub activity.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' } }, required: ['ok'], additionalProperties: true },
    render(_args, value) { return [{ type: 'text', text: String(value?.text ?? '') }] },
  },
  async execute() {
    const state = loadState(config ?? {})
    const counts = countsOf(state)
    const watched = (config?.repos?.length ? config.repos.join(', ') : runtime.repos.join(', ')) || '(尚未发现)'
    const lines = [
      `待你处理：${counts.pending} · 已看过：${counts.seen} · 已完成：${counts.done}`,
      `监视仓库：${watched}`,
      `上次轮询：${runtime.lastPollAt ? new Date(runtime.lastPollAt).toLocaleString() : '还没跑过'}`,
      `登录身份：${runtime.me || '(未知)'}`,
      `状态文件：${statePath(config ?? {})}`,
    ]
    if (runtime.lastPollError) lines.push(`上次错误：${runtime.lastPollError}`)
    return { ok: true, text: lines.join('\n') }
  },
})

/**
 * Which stored threads a digest lists.
 *
 * `deep` is `waiting` with more detail — it must select the same set. The first
 * version sent it down the "not pending" branch, so `deep` silently returned
 * "没有其他活动。" against four pending threads (found by calling the real tool, not
 * by previewing it).
 *
 * @param {Record<string, object>} threads
 * @param {{ wanted: string, bucket?: string, now?: number }} options
 * @returns {Array<[string, object]>} newest activity first
 */
export function selectDigestRows(threads, { wanted = 'waiting', bucket = 'all', now = Date.now() } = {}) {
  const wantsPending = wanted === 'waiting' || wanted === 'deep'
  const snoozed = (thread) => thread?.state === 'seen' && Number(thread?.snoozeUntil ?? 0) > now
  return Object.entries(threads ?? {})
    .filter(([, thread]) => {
      if (wantsPending) return thread?.state === 'pending' || snoozed(thread)
      // A snoozed thread is owed an answer, so it lives in "waiting" only — listing
      // it in "quiet" as well would show the same item twice.
      return thread?.state !== 'pending' && !snoozed(thread)
    })
    .filter(([, thread]) => bucket === 'all' || bucketOf(thread?.reason) === bucket)
    .sort((a, b) => Number(b[1]?.lastActivityAt ?? 0) - Number(a[1]?.lastActivityAt ?? 0))
}

const digestTool = (config) => ({
  name: 'repo_watch_digest',
  description:
    'List the threads the watchtower is tracking, with who spoke last and what they said. '
    + 'Call this whenever the user asks to see the detail after a watchtower push: "查看", "详情", '
    + '"展开", "看", "列表" all mean bucket "all"; "查看 1" / "看1" means bucket "reply"; '
    + '"查看 2" / "看2" means "action". Users reply briefly, so match on the intent, not on an exact word. '
    + 'kind="waiting" (default) returns what needs the user, "quiet" returns the rest, "deep" adds '
    + 'the stored reason and last actor for each thread.',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['waiting', 'quiet', 'deep'], description: 'Which digest to produce.' },
      bucket: {
        type: 'string',
        enum: ['all', 'reply', 'action', 'other'],
        description: 'Narrow to one bucket of the push roll-call: reply (someone answered you), action (someone opened something in your repos), all.',
      },
      limit: { type: 'number', description: 'Maximum threads to list (default 20).' },
    },
    required: ['kind'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' } }, required: ['ok'], additionalProperties: true },
    render(_args, value) { return [{ type: 'text', text: String(value?.text ?? '') }] },
  },
  async execute(args) {
    const state = loadState(config ?? {})
    const limit = Math.max(1, Number(args?.limit ?? 20))
    const wanted = String(args?.kind ?? 'waiting')
    const bucket = String(args?.bucket ?? 'all')

    // `quiet` answers "what else moved", which is activity, not threads: those
    // entries did not become pending, so they are not in the state machine.
    if (wanted === 'quiet') {
      const items = (Array.isArray(state.activity) ? state.activity : []).slice(0, limit)
      if (items.length === 0) return { ok: true, text: '最近没有其他动静。' }
      const lines = [`最近 ${items.length} 条其他动静：`]
      items.forEach((item, index) => {
        lines.push('')
        lines.push(`${index + 1}. ${item.key}${item.title ? `　${item.title}` : ''}`)
        lines.push(`   ${reasonText(item.reason)}${item.actor ? ` · ${item.actor}` : ''}${item.at ? `（${shortDay(item.at)}）` : ''}`)
        if (item.text) lines.push(`   ${item.text}`)
      })
      return { ok: true, text: lines.join('\n') }
    }

    const nowMs = Date.now()
    const rows = selectDigestRows(state.threads, { wanted, bucket, now: nowMs })
    if (rows.length === 0) {
      return { ok: true, text: wanted === 'waiting' || wanted === 'deep' ? '没有需要你处理的。' : '没有其他活动。' }
    }
    const shown = rows.slice(0, limit)
    const head = shown.length === 1 ? '1 条' : `${shown.length} 条`
    const lines = [`共 ${rows.length} 条，显示 ${head}：`]
    shown.forEach(([key, thread], index) => {
      lines.push('')
      lines.push(`${index + 1}. ${key}${thread.title ? `　${thread.title}` : ''}`)
      lines.push(`   ${reasonText(thread.reason, thread.kind)}`)
      const when = shortDay(thread.lastActivityAt)
      if (thread.lastActor) {
        lines.push(`   ${thread.lastActor}${when ? `（${when}）` : ''}${thread.lastText ? `：${thread.lastText}` : ''}`)
      } else if (when) {
        lines.push(`   ${when}`)
      }
      if (thread.url) lines.push(`   ${thread.url}`)
      if (Number(thread.snoozeUntil ?? 0) > Date.now()) {
        lines.push(`   已延后到 ${new Date(Number(thread.snoozeUntil)).toLocaleString()}`)
      }
      if (wanted === 'deep') {
        const classification = classify({ title: thread.title, kind: thread.kind })
        const progress = progressOf(thread.lastText)
        const ageDays = thread.lastActivityAt ? (Date.now() - Number(thread.lastActivityAt)) / 86_400_000 : 0
        const priority = priorityOf({
          classification, title: thread.title, reason: thread.reason,
          ageDays, notifyCount: Number(thread.notifyCount ?? 0), progress,
        })
        lines.push(`   判断：${classification.label} · 优先级${priority.label}（${priority.score >= 0 ? '+' : ''}${priority.score}）`)
        lines.push(`   进展：${progress.label}${progress.signal ? `（依据「${progress.signal}」）` : ''}`)
        if (priority.reasons.length) lines.push(`   理由：${priority.reasons.join('；')}`)
        const similar = similarTo({ key, title: thread.title }, Object.entries(state.threads)
          .filter(([other]) => other !== key)
          .map(([other, entry]) => ({ key: other, ...entry })))
        if (similar.length) {
          lines.push(`   相似：${similar.map((item) => `${item.key}（${item.state}）`).join('、')}`)
        }
        lines.push(`   状态：${thread.state} · 已提醒 ${Number(thread.notifyCount ?? 0)} 次`)
      }
    })
    if (rows.length > shown.length) lines.push('', `……还有 ${rows.length - shown.length} 条，加大 limit 或收窄 bucket。`)
    return { ok: true, text: lines.join('\n') }
  },
})

const ackTool = (config) => ({
  name: 'repo_watch_ack',
  description:
    'Mark a tracked thread as seen, done, or snoozed. This only writes the local state file; '
    + 'GitHub is never modified. A done thread comes back if new activity arrives.',
  parameters: {
    type: 'object',
    properties: {
      thread: { type: 'string', description: 'Thread key, "owner/repo#123".' },
      as: { type: 'string', enum: ['seen', 'done', 'snooze'], description: 'New state.' },
      hours: { type: 'number', description: 'Snooze length when as="snooze" (default 24).' },
    },
    required: ['thread', 'as'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' } }, required: ['ok'], additionalProperties: true },
    render(_args, value) { return [{ type: 'text', text: String(value?.text ?? '') }] },
  },
  async execute(args) {
    const key = String(args?.thread ?? '').trim()
    const target = String(args?.as ?? '').trim()
    const state = loadState(config ?? {})
    const thread = state.threads[key]
    if (!thread) return { ok: false, text: `没有这条记录：${key}` }
    if (target === 'snooze') {
      const hours = Math.max(1, Number(args?.hours ?? 24))
      thread.state = 'seen'
      thread.snoozeUntil = Date.now() + hours * oneHour
      thread.stateSince = Date.now()
    } else if (target === 'seen' || target === 'done') {
      thread.state = target
      thread.stateSince = Date.now()
      thread.snoozeUntil = 0
    } else {
      return { ok: false, text: `未知状态：${target}` }
    }
    saveState(config ?? {}, state)
    return { ok: true, text: `${key} → ${thread.state}${thread.snoozeUntil ? `（到 ${new Date(thread.snoozeUntil).toLocaleString()}）` : ''}` }
  },
})

const checkTool = (ctx, config) => ({
  name: 'repo_watch_check',
  description: 'Run one poll immediately instead of waiting for the background timer, then report what it found.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' } }, required: ['ok'], additionalProperties: true },
    render(_args, value) { return [{ type: 'text', text: String(value?.text ?? '') }] },
  },
  async execute() {
    const result = await pollOnce(ctx, config)
    if (!result.ok) return { ok: false, text: `轮询失败：${result.reason}` }
    await flushQueue(ctx, config)
    return {
      ok: true,
      text: `扫描 ${result.scanned} 条，新增待处理 ${result.fresh} 条`
        + (result.failures?.length ? `\n失败：${result.failures.join('; ')}` : ''),
    }
  },
})

/** Exposed for the smoke test: wiring a delay keeps timers testable. */
export const _internals = { pollOnce, pushText, runtime, delay, composeWaitingMessage, mergeActivity, selectDigestRows }
