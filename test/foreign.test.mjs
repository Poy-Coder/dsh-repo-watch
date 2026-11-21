/**
 * Threads in other people's repositories.
 *
 * Found on `awesome-dsh-plugin#15938`: it was closed (and its content merged by hand)
 * two days earlier, and the watchtower still listed it as waiting, because the
 * open/closed scans only walk the user's own repositories.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { foreignThreadsOf } from '../lib/triage.mjs'

test('only threads outside the polled repositories are returned', () => {
  const threads = {
    'Poy-Coder/dsh-channel-feishu#3': { state: 'pending' },
    'awesome-dsh-plugin/awesome-dsh-plugin#15938': { state: 'pending' },
    'hAcKlyc/MyAgents#646': { state: 'pending' },
  }
  const foreign = foreignThreadsOf({ threads, ownRepos: ['Poy-Coder/dsh-channel-feishu', 'poy-coder/other'] })
  assert.deepEqual(foreign.map((item) => item.key), [
    'awesome-dsh-plugin/awesome-dsh-plugin#15938',
    'hAcKlyc/MyAgents#646',
  ])
  assert.equal(foreign[0].repo, 'awesome-dsh-plugin/awesome-dsh-plugin')
  assert.equal(foreign[0].number, 15938)
})

test('the repository comparison ignores case', () => {
  const threads = { 'Poy-Coder/dsh-channel-feishu#3': { state: 'pending' } }
  assert.deepEqual(foreignThreadsOf({ threads, ownRepos: ['poy-coder/DSH-Channel-Feishu'] }), [])
})

test('settled and malformed keys are skipped', () => {
  const threads = {
    'o/r#1': { state: 'done' },
    'o/r#2': { state: 'seen', snoozeUntil: 5 },
    'not-a-thread': { state: 'pending' },
    'o/r#notanumber': { state: 'pending' },
    'o/r#3': { state: 'pending' },
  }
  assert.deepEqual(foreignThreadsOf({ threads, ownRepos: [] }).map((item) => item.key), ['o/r#2', 'o/r#3'])
})

test('empty inputs are not an error', () => {
  assert.deepEqual(foreignThreadsOf({}), [])
  assert.deepEqual(foreignThreadsOf({ threads: {} }), [])
  assert.deepEqual(foreignThreadsOf(), [])
})
