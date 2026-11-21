/**
 * Hermetic tests for the watchtower's judgement rules.
 *
 * The rules are what decide whether the user is interrupted, so they are pinned
 * here without a network, a clock, or a DSH runtime.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  bucketHint,
  bucketOf,
  bucketText,
  closureTargets,
  inQuietHours,
  isBotLogin,
  judgeNotification,
  judgeRepoItem,
  reasonText,
  shouldNotify,
  threadOf,
} from '../lib/triage.mjs'
import { excerptOf } from '../lib/github.mjs'

test('threadOf normalises issues and pull requests to one key', () => {
  assert.equal(threadOf('https://api.github.com/repos/o/r/issues/12').key, 'o/r#12')
  assert.equal(threadOf('https://api.github.com/repos/o/r/pulls/12').key, 'o/r#12')
  assert.equal(threadOf('https://api.github.com/repos/o/r/issues/12').kind, 'issue')
  assert.equal(threadOf('https://api.github.com/repos/o/r/pulls/12').kind, 'pr')
  assert.equal(threadOf('nonsense'), undefined)
  assert.equal(threadOf(undefined), undefined)
})

test('bot logins are recognised', () => {
  assert.equal(isBotLogin('dependabot[bot]'), true)
  assert.equal(isBotLogin('github-actions[bot]'), true)
  assert.equal(isBotLogin('renovate'), true)
  assert.equal(isBotLogin('Poy-Coder'), false)
  assert.equal(isBotLogin(''), false)
})

test('a reply on my own thread needs an answer', () => {
  const notification = { unread: true, reason: 'author' }
  assert.equal(judgeNotification({ notification, me: 'me', lastActor: 'them' }).pending, true)
  assert.equal(judgeNotification({ notification, me: 'me', lastActor: 'me' }).pending, false)
  assert.equal(judgeNotification({ notification, me: 'me', lastActor: 'dependabot[bot]' }).pending, false)
})

test('mentions and review requests always surface', () => {
  assert.equal(judgeNotification({ notification: { unread: true, reason: 'mention' }, me: 'me', lastActor: 'them' }).pending, true)
  assert.equal(judgeNotification({ notification: { unread: true, reason: 'team_mention' }, me: 'me' }).pending, true)
  assert.equal(judgeNotification({ notification: { unread: true, reason: 'review_requested' }, me: 'me' }).pending, true)
  // A mention I wrote myself is not addressed to me.
  assert.equal(judgeNotification({ notification: { unread: true, reason: 'mention' }, me: 'me', lastActor: 'me' }).pending, false)
})

test('subscription noise never interrupts', () => {
  for (const reason of ['subscribed', 'state_change', 'ci_activity', 'security_alert', 'manual']) {
    assert.equal(judgeNotification({ notification: { reason }, me: 'me' }).pending, false)
  }
  assert.equal(judgeNotification({ notification: undefined, me: 'me' }).pending, false)
})

test('a notification already marked read still counts', () => {
  // GitHub marks a thread read as soon as it is opened; treating that as "nothing
  // to do" is what buries a reply the user never answered.
  assert.equal(judgeNotification({ notification: { unread: false, reason: 'author' }, me: 'me', lastActor: 'them' }).pending, true)
})

test('an external issue in my repo needs a look, my own does not', () => {
  assert.equal(judgeRepoItem({ issue: { state: 'open', user: { login: 'them' } }, me: 'me' }).pending, true)
  assert.equal(judgeRepoItem({ issue: { state: 'open', user: { login: 'me' } }, me: 'me' }).pending, false)
  assert.equal(judgeRepoItem({ issue: { state: 'open', user: { login: 'dependabot[bot]' } }, me: 'me' }).pending, false)
  assert.equal(judgeRepoItem({ issue: { state: 'closed', user: { login: 'them' } }, me: 'me' }).pending, false)
  assert.equal(judgeRepoItem({ issue: { state: 'open', user: { login: 'them' }, pull_request: {} }, me: 'me' }).reason, 'external-pr')
})

test('announce only when a thread enters pending or reopens after done', () => {
  assert.equal(shouldNotify({ previous: undefined, pending: true }), true)
  assert.equal(shouldNotify({ previous: 'pending', pending: true }), false, 'still pending is not news')
  assert.equal(shouldNotify({ previous: 'seen', pending: true }), false, 'already seen is not news')
  assert.equal(shouldNotify({ previous: 'done', pending: true, lastActivityAt: 20, stateSince: 10 }), true)
  assert.equal(shouldNotify({ previous: 'done', pending: true, lastActivityAt: 5, stateSince: 10 }), false)
  assert.equal(shouldNotify({ previous: 'pending', pending: false }), false)
})

test('a snoozed thread stays pending but stays quiet', () => {
  const now = 1_000_000
  // 首次出现也按 snooze 静默：snooze 的语义是"先别告诉我"
  assert.equal(shouldNotify({ previous: undefined, pending: true, snoozeUntil: now + 60_000, now }), false)
  assert.equal(shouldNotify({ previous: 'done', pending: true, lastActivityAt: 20, stateSince: 10, snoozeUntil: now + 60_000, now }), false)
  // 到期后照常提醒
  assert.equal(shouldNotify({ previous: undefined, pending: true, snoozeUntil: now - 1, now }), true)
})

test('a done thread still reopens when new activity arrives after snooze', () => {
  const now = 1_000_000
  assert.equal(
    shouldNotify({ previous: 'done', pending: true, lastActivityAt: 90, stateSince: 10, snoozeUntil: now - 1, now }),
    true,
  )
})

test('an expired snooze resurfaces instead of going silent forever', () => {
  const now = 1_000_000
  // ack 把 snooze 记成 seen；若只按 seen 判定，这条永远不会再提醒
  assert.equal(
    shouldNotify({ previous: 'seen', pending: true, lastActivityAt: 90, stateSince: 10, snoozeUntil: now - 1, now }),
    true,
  )
  // 没有新活动就不该吵：snooze 到期只是"可以重新提醒"，不是"必须提醒"
  assert.equal(
    shouldNotify({ previous: 'seen', pending: true, lastActivityAt: 5, stateSince: 10, snoozeUntil: now - 1, now }),
    false,
  )
  // 仍在 snooze 内：安静
  assert.equal(
    shouldNotify({ previous: 'seen', pending: true, lastActivityAt: 90, stateSince: 10, snoozeUntil: now + 60_000, now }),
    false,
  )
})

test('a plain seen thread (never snoozed) stays quiet', () => {
  assert.equal(shouldNotify({ previous: 'seen', pending: true, lastActivityAt: 90, stateSince: 10, snoozeUntil: 0 }), false)
})

test('a closure settles only threads already tracked', () => {
  const threads = {
    'o/r#1': { state: 'pending' },
    'o/r#2': { state: 'done' },
  }
  const items = [
    { url: 'https://api.github.com/repos/o/r/issues/1' },
    { url: 'https://api.github.com/repos/o/r/issues/2' },
    { url: 'https://api.github.com/repos/o/r/issues/9' },
    { url: 'nonsense' },
  ]
  // #1 待处理 → 结案；#2 已 done → 不重复；#9 从未跟踪 → 不为它建条目
  assert.deepEqual(closureTargets({ items, threads }), ['o/r#1'])
})

test('the same closure reported twice settles once', () => {
  const threads = { 'o/r#1': { state: 'pending' } }
  const items = [
    { url: 'https://api.github.com/repos/o/r/issues/1' },
    { url: 'https://api.github.com/repos/o/r/pulls/1' },
  ]
  assert.deepEqual(closureTargets({ items, threads }), ['o/r#1'])
})

test('no threads or no items is not an error', () => {
  assert.deepEqual(closureTargets({ items: [], threads: { 'o/r#1': { state: 'pending' } } }), [])
  assert.deepEqual(closureTargets({ items: [{ url: 'https://api.github.com/repos/o/r/issues/1' }], threads: {} }), [])
  assert.deepEqual(closureTargets({}), [])
})

test('quiet hours wrap around midnight', () => {
  assert.equal(inQuietHours(23, '23-8'), true)
  assert.equal(inQuietHours(3, '23-8'), true)
  assert.equal(inQuietHours(7, '23-8'), true)
  assert.equal(inQuietHours(8, '23-8'), false)
  assert.equal(inQuietHours(12, '23-8'), false)
  assert.equal(inQuietHours(12, '9-18'), true)
  assert.equal(inQuietHours(12, ''), false)
  assert.equal(inQuietHours(12, '9-9'), false)
})

test('every reason has Chinese wording, never the internal key', () => {
  const reasons = [
    'someone-replied-to-my-thread',
    'someone-joined-my-thread',
    'mentioned',
    'review-requested',
    'external-issue',
    'external-pr',
  ]
  for (const reason of reasons) {
    const text = reasonText(reason)
    assert.ok(text.length > 0, `${reason} has no wording`)
    assert.doesNotMatch(text, /-/, `${reason} leaked the internal key`)
    assert.match(text, /[\u4e00-\u9fa5]/, `${reason} is not Chinese`)
  }
  // 未知原因也要给出可读的兜底，而不是把 key 直接抛给用户
  assert.match(reasonText('something-new'), /[\u4e00-\u9fa5]/)
})

test('a comment excerpt is one readable line', () => {
  const body = [
    '## 本机取证进展',
    '',
    '> 引用的原话',
    '',
    '```js',
    'const hidden = true',
    '```',
    '详见 [文档](https://example.com) 与 ![图](https://example.com/x.png)',
    '<details>block</details>',
  ].join('\n')
  const text = excerptOf(body, 60)
  assert.doesNotMatch(text, /\n/)
  assert.doesNotMatch(text, /```|!\[|<details>|##/)
  assert.ok(text.length <= 60)
  assert.match(text, /本机取证进展/)
})

test('long excerpts are truncated at the requested length', () => {
  const text = excerptOf('一'.repeat(200), 40)
  assert.equal(text.length, 40)
  assert.ok(text.endsWith('…'))
})

test('every judgement lands in exactly one push bucket', () => {
  assert.equal(bucketOf('someone-replied-to-my-thread'), 'reply')
  assert.equal(bucketOf('mentioned'), 'reply')
  assert.equal(bucketOf('review-requested'), 'reply')
  assert.equal(bucketOf('external-issue'), 'action')
  assert.equal(bucketOf('external-pr'), 'action')
  assert.equal(bucketOf('something-unknown'), 'other')
  // 推送里出现的是中文分类名与说明，不是 bucket 的英文 key
  for (const bucket of ['reply', 'action', 'other']) {
    assert.match(bucketText(bucket), /[\u4e00-\u9fa5]/)
    assert.match(bucketHint(bucket), /[\u4e00-\u9fa5]/)
  }
  assert.equal(bucketText('reply'), '需要你回复')
  assert.equal(bucketText('action'), '需要你处理')
})
