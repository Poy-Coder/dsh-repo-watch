/**
 * The queue is not the truth.
 *
 * An announcement can wait hours (quiet hours, hourly cap) while its thread is
 * resolved — merged, closed, acked. Sending it then produces a roll-call for finished
 * work: on 2026-11-22 the watchtower announced "1 needs you" for a PR that had been
 * merged four hours earlier and settled seven hours before the send.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { partitionQueue } from '../lib/triage.mjs'

const entry = (key) => ({ key, reason: 'someone-replied-to-my-thread' })

test('only still-pending threads survive the queue', () => {
  const threads = {
    'o/r#1': { state: 'pending' },
    'o/r#2': { state: 'done' },
    'o/r#3': { state: 'seen' },
  }
  const { live, dropped } = partitionQueue([entry('o/r#1'), entry('o/r#2'), entry('o/r#3')], threads)
  assert.deepEqual(live.map((item) => item.key), ['o/r#1'])
  assert.equal(dropped, 2)
})

test('a thread that was pruned from the store is not announced', () => {
  const { live, dropped } = partitionQueue([entry('o/r#9')], {})
  assert.deepEqual(live, [])
  assert.equal(dropped, 1)
})

test('the order of live entries is preserved', () => {
  const threads = { 'o/r#1': { state: 'pending' }, 'o/r#2': { state: 'pending' } }
  const { live } = partitionQueue([entry('o/r#2'), entry('o/r#1')], threads)
  assert.deepEqual(live.map((item) => item.key), ['o/r#2', 'o/r#1'])
})

test('an empty queue is not an error', () => {
  assert.deepEqual(partitionQueue([], {}), { live: [], dropped: 0 })
  assert.deepEqual(partitionQueue(undefined, undefined), { live: [], dropped: 0 })
})

test('a thread without a state field counts as settled', () => {
  const { live, dropped } = partitionQueue([entry('o/r#1')], { 'o/r#1': {} })
  assert.deepEqual(live, [])
  assert.equal(dropped, 1)
})
