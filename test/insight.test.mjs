/**
 * The `deep` digest's judgement: classification, priority, similar threads.
 *
 * These are rules, so they are pinned here: a priority that cannot be explained is
 * worse than no priority at all.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { classify, priorityOf, similarTo, tokensOf } from '../lib/insight.mjs'

test('labels win over wording', () => {
  assert.equal(classify({ title: '怎么用这个功能', labels: ['bug'] }).kind, 'bug')
  assert.equal(classify({ title: '怎么用这个功能', labels: [] }).kind, 'question')
})

test('the four kinds are recognised from wording alone', () => {
  assert.equal(classify({ title: '启动时崩溃，无法打开' }).kind, 'bug')
  assert.equal(classify({ title: '希望支持批量导出' }).kind, 'feature')
  assert.equal(classify({ title: '这个参数怎么设置？' }).kind, 'question')
  assert.equal(classify({ title: 'README 里的示例有错别字' }).kind, 'docs')
  assert.equal(classify({ title: 'dsh-repo-watch#42' }).kind, 'other')
})

test('classification names the signal it used', () => {
  const byLabel = classify({ title: 'x', labels: ['regression'] })
  assert.equal(byLabel.kind, 'bug')
  assert.match(byLabel.signals.join(), /标签/)
  const byText = classify({ title: '启动就崩溃' })
  assert.match(byText.signals.join(), /标题措辞/)
})

test('priority is explainable and ordered', () => {
  const regression = priorityOf({
    classification: { kind: 'bug' },
    title: '回归：以前可以启动，现在启动不了',
    reason: 'someone-replied-to-my-thread',
  })
  const question = priorityOf({ classification: { kind: 'question' }, title: '怎么设置？' })
  assert.ok(regression.score > question.score, '回归缺陷应当比提问更急')
  assert.equal(regression.level, 'high')
  assert.ok(regression.reasons.length >= 2)
  for (const reason of regression.reasons) assert.match(reason, /[\u4e00-\u9fa5]/)
})

test('review requests and mentions raise the level', () => {
  const review = priorityOf({ classification: { kind: 'other' }, title: 'x', reason: 'review-requested' })
  const mention = priorityOf({ classification: { kind: 'other' }, title: 'x', reason: 'mentioned' })
  assert.ok(review.score > mention.score)
  assert.match(review.reasons.join(), /review/)
})

test('a thread announced three times is escalated, not ignored', () => {
  const once = priorityOf({ classification: { kind: 'bug' }, title: '崩溃', notifyCount: 1 })
  const many = priorityOf({ classification: { kind: 'bug' }, title: '崩溃', notifyCount: 4 })
  assert.ok(many.score > once.score)
  assert.match(many.reasons.join(), /已提醒/)
})

test('tokens drop filler words and keep CJK bigrams', () => {
  const tokens = tokensOf('无法启动 the app after update 无法启动')
  assert.ok(tokens.has('启动'))
  assert.ok(tokens.has('app'))
  assert.ok(tokens.has('update'))
  assert.equal(tokens.has('the'), false)
  assert.equal(tokens.has('无法'), false, 'stop word')
})

test('similar threads need two shared tokens and the same repository', () => {
  const target = { key: 'o/r#1', title: '启动时崩溃 crash on startup' }
  const threads = [
    { key: 'o/r#2', title: '启动崩溃 crash after update', state: 'done' },
    { key: 'o/r#3', title: '启动问题', state: 'pending' },
    { key: 'other/repo#4', title: '启动崩溃 crash on startup', state: 'pending' },
    { key: 'o/r#1', title: '启动崩溃', state: 'pending' },
  ]
  const similar = similarTo(target, threads)
  assert.deepEqual(similar.map((item) => item.key), ['o/r#2'])
  assert.equal(similar[0].state, 'done')
})

test('no tokens means no guesses', () => {
  assert.deepEqual(similarTo({ key: 'o/r#1', title: '' }, [{ key: 'o/r#2', title: 'x' }]), [])
})
