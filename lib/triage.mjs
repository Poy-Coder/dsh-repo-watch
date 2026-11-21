/**
 * Pure decision logic for the watchtower.
 *
 * Everything here is a function of plain data (a notification, an issue, the
 * viewer's login), so the rules that decide "does this need a human" can be
 * tested without a network, a clock, or a DSH runtime. The poller and the state
 * file stay in `index.mjs`; this file only answers questions.
 */

/** GitHub marks bot accounts with a `[bot]` suffix; some automation uses other names. */
const BOT_LOGIN = /\[bot\]$|^(dependabot|renovate|github-actions|codecov|snyk-bot)$/i

export function isBotLogin(login) {
  return BOT_LOGIN.test(String(login ?? '').trim())
}

/**
 * Subject URL → the thread identity the state file is keyed by.
 * `…/repos/o/r/issues/12` and `…/repos/o/r/pulls/12` are the same thread.
 * @param {string} url
 * @returns {{ repo: string, number: number, kind: 'issue' | 'pr', key: string } | undefined}
 */
export function threadOf(url) {
  const m = /repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)/.exec(String(url ?? ''))
  if (!m) return undefined
  const repo = m[1]
  const number = Number(m[3])
  const kind = m[2] === 'pulls' ? 'pr' : 'issue'
  return { repo, number, kind, key: `${repo}#${number}` }
}

/**
 * Notification reasons that can mean "someone is waiting on you". The rest
 * (`subscribed`, `state_change`, `ci_activity`, `security_alert`, `manual`) are
 * activity to know about, not something to answer.
 */
const ACTIONABLE_REASONS = new Set(['author', 'comment', 'mention', 'team_mention', 'review_requested'])

export function isActionableReason(reason) {
  return ACTIONABLE_REASONS.has(String(reason ?? ''))
}

/**
 * Which bucket a judgement belongs to.
 *
 * The push is a short roll-call, not a dump: the reader decides whether to look
 * before reading anything. Two buckets matter — a thread that wants an answer, and
 * a thread that wants a decision (somebody opened something in the repository).
 * @param {string} reason
 * @returns {'reply' | 'action' | 'other'}
 */
export function bucketOf(reason) {
  switch (String(reason ?? '')) {
    case 'someone-replied-to-my-thread':
    case 'someone-joined-my-thread':
    case 'mentioned':
    case 'review-requested':
      return 'reply'
    case 'external-issue':
    case 'external-pr':
      return 'action'
    default:
      return 'other'
  }
}

/** Human name of a bucket, used in the roll-call and the digest. */
export function bucketText(bucket) {
  switch (String(bucket ?? '')) {
    case 'reply': return '需要你回复'
    case 'action': return '需要你处理'
    default: return '其他动静'
  }
}

/** One short clause explaining why a bucket has items. */
export function bucketHint(bucket) {
  switch (String(bucket ?? '')) {
    case 'reply': return '有人回复了你提的 issue/PR、@ 了你，或请你 review'
    case 'action': return '有人给你的仓库开了 issue 或提了 PR'
    default: return '订阅里的其他变化'
  }
}

/**
 * Human wording for a judgement reason.
 *
 * The first release pushed the raw reason keys (`someone-replied-to-my-thread`)
 * straight into the chat, which is unreadable if you are not the person who wrote
 * the code. Every user-facing string goes through this map instead.
 * @param {string} reason a reason returned by {@link judgeNotification} or {@link judgeRepoItem}
 * @param {'issue' | 'pr'} [kind] thread kind, so a pull request is not called an issue
 * @returns {string} a short sentence for a chat message
 */
export function reasonText(reason, kind = 'issue') {
  const isPr = kind === 'pr'
  switch (String(reason ?? '')) {
    case 'someone-replied-to-my-thread':
      return isPr ? '有人回复了你提的 PR' : '有人回复了你提的 issue'
    case 'someone-joined-my-thread':
      return isPr ? '有人在你参与的 PR 里发言' : '有人在你参与的 issue 里发言'
    case 'mentioned':
      return '有人 @ 了你'
    case 'review-requested':
      return '有人请你 review 这个 PR'
    case 'external-issue':
      return '有人给你的仓库开了 issue'
    case 'external-pr':
      return '有人给你的仓库提了 PR'
    default:
      return '有新的动静'
  }
}

/**
 * Judge one GitHub notification.
 *
 * GitHub's `author` reason fires for every comment on a thread you opened, so the
 * last human speaker is what actually decides it. The `unread` flag is ignored on
 * purpose: opening a notification marks it read and loses it forever, which is the
 * exact failure this plugin exists to fix — the local state machine decides what
 * is news, not GitHub's read state.
 *
 * @param {object} input
 * @param {object} input.notification a `/notifications` item
 * @param {string} input.me the authenticated login
 * @param {string} [input.lastActor] login of the newest human comment, when known
 * @returns {{ pending: boolean, reason: string }}
 */
export function judgeNotification({ notification, me, lastActor }) {
  if (!notification) return { pending: false, reason: 'no-notification' }
  const reason = String(notification.reason ?? '')
  if (!isActionableReason(reason)) return { pending: false, reason: `reason:${reason || 'unknown'}` }

  const actor = String(lastActor ?? '').trim()
  if (actor && isBotLogin(actor)) return { pending: false, reason: 'bot-activity' }
  if (reason === 'mention' || reason === 'team_mention') {
    // A mention is addressed to a person even when the thread is mine.
    return { pending: actor && actor === me ? false : true, reason: 'mentioned' }
  }
  if (reason === 'review_requested') return { pending: true, reason: 'review-requested' }
  if (actor && actor === me) return { pending: false, reason: 'i-spoke-last' }
  // `author`/`comment` with no known speaker still means somebody else acted.
  return { pending: true, reason: reason === 'author' ? 'someone-replied-to-my-thread' : 'someone-joined-my-thread' }
}

/**
 * Judge one issue/PR found by the repo scan — the "somebody opened something in
 * my repository" rule, which no notification covers unless the thread is watched.
 * @param {object} issue an `/issues` item
 * @param {string} me
 * @returns {{ pending: boolean, reason: string }}
 */
export function judgeRepoItem({ issue, me }) {
  if (!issue) return { pending: false, reason: 'no-item' }
  const author = String(issue.user?.login ?? '')
  if (issue.state === 'closed') return { pending: false, reason: 'closed' }
  if (author === me) return { pending: false, reason: 'mine' }
  if (isBotLogin(author)) return { pending: false, reason: 'bot-activity' }
  return { pending: true, reason: issue.pull_request ? 'external-pr' : 'external-issue' }
}

/**
 * Tracked threads that live in repositories the watchtower does not poll.
 *
 * The open/closed scan only walks the user's own repositories, so a PR filed in
 * somebody else's project is never re-read after the first notification — it stays
 * "waiting on you" even after it was merged or closed (found on
 * `awesome-dsh-plugin#15938`, closed two days earlier). These threads need a direct
 * state check instead.
 *
 * @param {{ threads: Record<string, object>, ownRepos?: string[] }} input
 * @returns {Array<{ key: string, repo: string, number: number }>}
 */
export function foreignThreadsOf({ threads, ownRepos = [] } = {}) {
  const own = new Set((Array.isArray(ownRepos) ? ownRepos : []).map((repo) => String(repo).toLowerCase()))
  const out = []
  for (const [key, thread] of Object.entries(threads ?? {})) {
    if (!thread || thread.state === 'done') continue
    const match = /^([^/#]+\/[^/#]+)#(\d+)$/.exec(String(key))
    if (!match) continue
    const repo = match[1]
    if (own.has(repo.toLowerCase())) continue
    out.push({ key, repo, number: Number(match[2]) })
  }
  return out
}

/**
 * Tracked threads that a closure settles.
 *
 * Only threads the watchtower already knows are returned: a closure of something
 * it never tracked is not news, and creating a `done` entry for every closed issue
 * in the account would grow the state file for nothing.
 *
 * @param {{ items: Array<{ url?: string }>, threads: Record<string, object> }} input
 * @returns {string[]} thread keys to settle
 */
export function closureTargets({ items, threads }) {
  const keys = []
  for (const item of Array.isArray(items) ? items : []) {
    const thread = threadOf(item?.url)
    if (!thread) continue
    const stored = threads?.[thread.key]
    if (!stored) continue
    if (stored.state === 'done') continue
    keys.push(thread.key)
  }
  return [...new Set(keys)]
}

/**
 * Which transitions must be announced.
 *
 * The rule the whole product rests on: speak only when a thread *enters* pending,
 * or re-enters it after being marked done. Everything else — staying pending,
 * being seen, staying done — is silent.
 *
 * @param {object} input
 * @param {'pending' | 'seen' | 'done'} [input.previous] stored state, when known
 * @param {boolean} input.pending the fresh judgement
 * @param {number} [input.lastActivityAt] activity that triggered this judgement
 * @param {number} [input.stateSince] when the stored state was entered
 * @param {number} [input.snoozeUntil] silence this thread until then
 * @param {number} [input.now] clock, so the snooze rule is testable
 * @returns {boolean}
 */
/**
 * Whether a stored thread should be pending after this poll.
 *
 * `done` and `seen` are the user's decisions, so a verdict that still says "someone
 * is waiting" must not overwrite them: that condition stays true forever until the
 * other side speaks again, which made `ack` last exactly one poll — a thread marked
 * done reappeared 15 minutes later. Only new activity reopens a decision.
 *
 * @param {object} input
 * @param {boolean} input.pending the fresh judgement
 * @param {'pending' | 'seen' | 'done'} [input.previous]
 * @param {number} [input.lastActivityAt]
 * @param {number} [input.stateSince] when the stored state was entered
 * @returns {boolean}
 */
export function effectivePending({ pending, previous, lastActivityAt = 0, stateSince = 0 }) {
  if (!pending) return false
  if (previous === 'done' || previous === 'seen') return Number(lastActivityAt) > Number(stateSince)
  return true
}

export function shouldNotify({ previous, pending, lastActivityAt = 0, stateSince = 0, snoozeUntil = 0, now = Date.now() }) {
  if (!pending) return false
  const snoozed = Number(snoozeUntil) > Number(now)
  // A snoozed thread stays pending — it still needs an answer, just not now.
  if (snoozed) return false
  if (previous === undefined) return true
  if (previous === 'pending') return false
  // `done` / `seen` were settled by the user: only newer activity is news again.
  return Number(lastActivityAt) > Number(stateSince)
}

/**
 * Stay inside the quiet window.
 * @param {number} hour local hour, 0–23
 * @param {string} window `"23-8"` style, start inclusive end exclusive
 */
export function inQuietHours(hour, window) {
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(String(window ?? '').trim())
  if (!m) return false
  const start = Number(m[1]) % 24
  const end = Number(m[2]) % 24
  const h = Number(hour) % 24
  if (start === end) return false
  return start < end ? h >= start && h < end : h >= start || h < end
}
