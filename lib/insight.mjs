/**
 * Reading a thread: what kind of report is it, how urgent does it look, and what
 * has happened to similar ones here before.
 *
 * Deliberately rule-based. The `deep` digest is asked for while triaging, and a
 * model call there would be slow, non-reproducible, and impossible to explain —
 * "why is this high priority" must have an answer the maintainer can check. Every
 * judgement therefore returns the signals that produced it.
 */

const KIND_RULES = [
  {
    kind: 'bug',
    label: '缺陷',
    labels: /^(bug|crash|regression|broken)/i,
    // `bug` must be here as well as in the labels: maintainers write "[Bug] …" in the
    // title far more often than they add the label, and the first version only
    // matched labels, so every such report fell through to "其他".
    text: /(报错|崩溃|异常|无法|失败|不工作|挂了|闪退|\bbug\b|\berror\b|exception|crash|fail|broken|regression)/i,
  },
  {
    kind: 'feature',
    label: '功能请求',
    labels: /^(enhancement|feature|request)/i,
    text: /(希望|建议|能否|可不可以|支持一下|新增|feature request|would be nice|please add|support for)/i,
  },
  {
    kind: 'question',
    label: '提问',
    labels: /^(question|help|how-?to)/i,
    text: /(怎么|如何|为什么|请问|求教|是不是|能否问|how do|how to|why does|\?|？)/i,
  },
  {
    kind: 'docs',
    label: '文档',
    labels: /^(docs?|documentation)/i,
    text: /(文档|说明|readme|示例|example|typo|错别字)/i,
  },
]

/**
 * What kind of report this is.
 * @param {{ title?: string, labels?: string[], kind?: 'issue' | 'pr' }} input
 * @returns {{ kind: string, label: string, signals: string[] }}
 */
export function classify({ title = '', labels = [], kind = 'issue' } = {}) {
  const text = String(title ?? '')
  const signals = []
  for (const rule of KIND_RULES) {
    const hitLabel = (Array.isArray(labels) ? labels : []).find((name) => rule.labels.test(String(name ?? '')))
    if (hitLabel) signals.push(`标签 ${hitLabel}`)
    const hitText = rule.text.test(text)
    if (hitText) signals.push('标题措辞')
    if (hitLabel || hitText) return { kind: rule.kind, label: rule.label, signals }
  }
  // A pull request is a different animal from an unclassified report: it is a
  // contribution to review or merge, not a report that may be missing details.
  if (kind === 'pr') return { kind: 'pr', label: '变更/PR', signals: ['类型为 PR'] }
  return { kind: 'other', label: '其他', signals: [] }
}

/** Phrases that tell you where the other side stands. */
const PROGRESS_RULES = [
  {
    state: 'resolved',
    label: '对方说已处理',
    text: /(已修复|已合并|已经合并|已发布|已收录|已解决|fix(ed)? in|merged|released|resolved|landed in)/i,
  },
  {
    state: 'asked-back',
    label: '对方在等你补充',
    text: /(能否提供|能不能提供|麻烦你|需要你|请补充|请提供|发一下|贴一下|could you|can you provide|need more info|waiting for you|any update)/i,
  },
  {
    state: 'working',
    label: '对方在推进',
    text: /(排查|定位|复现|修复中|处理中|正在看|调查|计划|下一步|investigating|looking into|reproduced?|working on|will fix|in progress|trace)/i,
  },
]

/**
 * Where the conversation stands, from the other side's last words.
 *
 * The stored excerpt is enough — no extra request, and no model: the difference
 * between "已在排查" and "能否提供日志" is exactly the difference between "wait" and
 * "answer now", and both are phrases a maintainer writes plainly.
 *
 * @param {string} text the newest human comment's excerpt
 * @returns {{ state: string, label: string, signal: string }}
 */
export function progressOf(text) {
  const body = String(text ?? '')
  if (!body.trim()) return { state: 'unknown', label: '没有可见的最新发言', signal: '' }
  for (const rule of PROGRESS_RULES) {
    const hit = rule.text.exec(body)
    if (hit) return { state: rule.state, label: rule.label, signal: hit[0] }
  }
  return { state: 'unknown', label: '看不出进展', signal: '' }
}

/** Score thresholds for the human-readable level. */
const LEVELS = [
  { min: 5, level: 'high', label: '高' },
  { min: 2, level: 'medium', label: '中' },
  { min: -Infinity, level: 'low', label: '低' },
]

/**
 * How urgent a thread looks, with the reasons spelled out.
 *
 * Only signals the watchtower already stores are used, so this never costs a
 * request and never changes between two identical calls.
 *
 * @param {object} input
 * @param {{ kind: string }} input.classification
 * @param {string} [input.title]
 * @param {string} [input.reason] the pending reason
 * @param {number} [input.ageDays] days since the last activity
 * @param {number} [input.notifyCount] how often it has already been announced
 * @param {{ state: string }} [input.progress] where the other side stands
 * @returns {{ score: number, level: string, label: string, reasons: string[] }}
 */
export function priorityOf({ classification, title = '', reason = '', ageDays = 0, notifyCount = 0, progress } = {}) {
  const text = String(title ?? '')
  const reasons = []
  let score = 0
  const add = (points, why) => { score += points; reasons.push(why) }

  // What the other side said matters more than how old the thread is: "已修复" means
  // this may already be done, and "能否提供日志" means it is your move.
  const progressState = String(progress?.state ?? '')
  if (progressState === 'resolved') add(-3, '对方说已修复/已合并，可能只差关掉')
  if (progressState === 'working') add(-2, '对方在推进，可以先等')
  if (progressState === 'asked-back') add(2, '对方在等你补充信息')

  if (/regression|回归|以前可以|used to work/i.test(text)) add(3, '提到回归（以前可用）')
  if (/数据丢失|丢数据|data loss|丢消息|丢失/i.test(text)) add(3, '涉及数据丢失')
  if (/无法启动|启动不了|crash|崩溃|闪退/i.test(text)) add(2, '影响启动或直接崩溃')
  if (reason === 'review-requested') add(3, '你被请求 review，阻塞别人')
  if (reason === 'mentioned') add(2, '对方 @ 了你')
  if (reason === 'someone-replied-to-my-thread') add(2, '你提的 thread 有人回复')
  if (String(classification?.kind) === 'question' || String(classification?.kind) === 'docs') add(-1, '提问或文档类，通常不急')
  if (String(classification?.kind) === 'pr') add(0, '是一条 PR，等你审阅或合并')
  if (String(classification?.kind) === 'other') add(-1, '无法归类，信息可能不足')
  if (!text.trim()) add(-2, '只有编号没有标题')
  if (Number(notifyCount) >= 3) add(2, `已提醒 ${notifyCount} 次仍挂着`)
  if (Number(ageDays) >= 7) add(1, `已放置 ${Math.round(ageDays)} 天`)

  const level = LEVELS.find((entry) => score >= entry.min)
  return { score, level: level.level, label: level.label, reasons }
}

/** Words that carry no signal when comparing two titles. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was',
  'bug', 'issue', 'error', 'problem', 'support', 'please', 'help', 'add', 'fix',
  '无法', '不能', '问题', '报错', '异常', '怎么', '如何', '请问', '希望', '建议',
])

/** Latin words plus CJK bigrams: no tokenizer, but enough to find siblings. */
export function tokensOf(text) {
  const raw = String(text ?? '').toLowerCase()
  const out = new Set()
  for (const word of raw.match(/[a-z0-9][a-z0-9+._-]{1,}/g) ?? []) {
    if (!STOP.has(word) && word.length >= 3) out.add(word)
  }
  const cjk = raw.match(/[\u4e00-\u9fa5]+/g) ?? []
  for (const run of cjk) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bigram = run.slice(i, i + 2)
      if (!STOP.has(bigram)) out.add(bigram)
    }
  }
  return out
}

/**
 * Threads that look like the same report.
 *
 * Same repository only: two projects sharing a word rarely share a cause, and a
 * cross-repo match would read as noise. Ranked by shared tokens, then recency.
 *
 * @param {{ key: string, title?: string }} target
 * @param {Array<{ key: string, title?: string, state?: string, lastActivityAt?: number }>} threads
 * @param {{ limit?: number }} [options]
 * @returns {Array<{ key: string, title: string, state: string, shared: number }>}
 */
export function similarTo(target, threads, { limit = 3 } = {}) {
  const repo = String(target?.key ?? '').split('#')[0]
  const mine = tokensOf(target?.title)
  if (!repo || mine.size === 0) return []
  const scored = []
  for (const thread of Array.isArray(threads) ? threads : []) {
    if (!thread?.key || thread.key === target.key) continue
    if (String(thread.key).split('#')[0] !== repo) continue
    const theirs = tokensOf(thread.title)
    let shared = 0
    for (const token of mine) if (theirs.has(token)) shared += 1
    // One shared word is usually the topic, not the same bug.
    if (shared < 2) continue
    scored.push({ key: thread.key, title: String(thread.title ?? ''), state: String(thread.state ?? ''), shared })
  }
  return scored
    .sort((a, b) => b.shared - a.shared)
    .slice(0, limit)
}
