/**
 * The push message is the whole product surface for most users, so its wording is
 * pinned here: no emoji, an explicit source, a readable prompt, and the type of the
 * newest thread spelled out.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { _internals } from '../index.mjs'

const { composeWaitingMessage, mergeActivity } = _internals

const entry = (over = {}) => ({
  key: 'owner/repo#1',
  title: 'Some title',
  thread: { kind: 'issue' },
  reason: 'someone-replied-to-my-thread',
  actor: 'them',
  snippet: 'hello',
  lastActivityAt: 1_700_000_000_000,
  url: 'https://github.com/owner/repo/issues/1',
  ...over,
})

test('the roll-call carries no emoji', () => {
  const text = composeWaitingMessage([entry(), entry({ key: 'owner/repo#2' })])
  assert.doesNotMatch(text, /\p{Extended_Pictographic}/u)
})

test('the header counts the messages and names the source', () => {
  const text = composeWaitingMessage([entry(), entry({ key: 'owner/repo#2' })])
  assert.match(text, /^有 2 条新消息（来源：GitHub）$/m)

  const single = composeWaitingMessage([entry()])
  assert.match(single, /^有 1 条新消息（来源：GitHub）$/m)
})

test('the prompt asks for 查看 while still accepting a short reply', () => {
  const text = composeWaitingMessage([entry()])
  assert.match(text, /回复「查看」查看全部明细/)
  // 该字单独出现时不算提示，避免让人以为只能回一个字
  assert.doesNotMatch(text, /回复「看」/)
})

test('bucket lines explain what each group wants', () => {
  const text = composeWaitingMessage([
    entry(),
    entry({ key: 'owner/repo#2', reason: 'external-issue' }),
  ])
  assert.match(text, /需要你回复 1 条/)
  assert.match(text, /需要你处理 1 条/)
  assert.match(text, /「查看 1」/)
  assert.match(text, /「查看 2」/)
})

test('the newest line names the thread type', () => {
  const issueText = composeWaitingMessage([entry()])
  assert.match(issueText, /最近一条：owner\/repo#1　Some title（issue）/)

  const prText = composeWaitingMessage([entry({ thread: { kind: 'pr' } })])
  assert.match(prText, /最近一条：owner\/repo#1　Some title（PR）/)
})

test('the newest line is the most recent thread', () => {
  const text = composeWaitingMessage([
    entry({ key: 'owner/repo#old', lastActivityAt: 1_000 }),
    entry({ key: 'owner/repo#new', lastActivityAt: 9_000 }),
  ])
  assert.match(text, /最近一条：owner\/repo#new/)
})

test('quiet activity keeps one entry per thread, newest wins', () => {
  const now = 10_000_000
  const merged = mergeActivity(
    [{ key: 'a#1', at: now - 100, title: 'old' }, { key: 'b#2', at: now - 200, title: 'b' }],
    [{ key: 'a#1', at: now - 10, title: 'new' }, { key: 'c#3', at: now - 50, title: 'c' }],
    now,
  )
  assert.equal(merged.length, 3)
  assert.equal(merged[0].key, 'a#1', 'newest first')
  assert.equal(merged[0].title, 'new', 'newest wins for the same thread')
  assert.deepEqual(merged.map((item) => item.key), ['a#1', 'c#3', 'b#2'])
})

test('quiet activity forgets what is older than a month', () => {
  const now = 10_000_000_000
  const merged = mergeActivity(
    [{ key: 'stale#1', at: now - 40 * 24 * 3600_000 }],
    [{ key: 'fresh#2', at: now - 1000 }],
    now,
  )
  assert.deepEqual(merged.map((item) => item.key), ['fresh#2'])
})
