/**
 * The diagnostic log.
 *
 * It exists because a logging call once broke a send: the plugin referenced a
 * `logInbound` it never defined, so recording a delivered push threw, the dispatch
 * catch reported failure, and the queue retried an already delivered message. The
 * log must therefore never throw, and it must actually appear on disk.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { logPath, logRecord } from '../lib/log.mjs'
import { _internals } from '../index.mjs'

test('a record lands as one JSONL line under DSH_HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-repo-watch-log-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.equal(logPath(), join(home, 'repo-watch.log'))
    logRecord({ event: 'push', result: 'sent', tool: 'feishu_send_message' })
    logRecord({ event: 'push', result: 'skipped', reason: 'hourly-limit' })
    const lines = readFileSync(logPath(), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0])
    assert.equal(first.event, 'push')
    assert.equal(first.result, 'sent')
    assert.equal(typeof first.time, 'number')
    assert.equal(JSON.parse(lines[1]).reason, 'hourly-limit')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('logging never throws, even with nothing serialisable', () => {
  // Isolate: an earlier version wrote to the real ~/.dsh and polluted it.
  const home = mkdtempSync(join(tmpdir(), 'dsh-repo-watch-log-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const circular = { event: 'push' }
    circular.self = circular
    assert.doesNotThrow(() => logRecord(circular))
    assert.doesNotThrow(() => logRecord(undefined))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a writer that cannot append does not propagate', () => {
  const previous = process.env.DSH_HOME
  // A path that cannot be a directory: appending under it must fail silently.
  process.env.DSH_HOME = join(tmpdir(), 'dsh-repo-watch-log-\u0000bad')
  try {
    assert.doesNotThrow(() => logRecord({ event: 'push', result: 'sent' }))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('the plugin no longer calls an undefined logger', () => {
  // 这条断言防的是本次真实事故：模块里出现 logInbound 却没有定义
  const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.equal(/logInbound\(/.test(source), false, 'index.mjs must not call logInbound')
  assert.equal(typeof _internals.pollOnce, 'function')
  assert.equal(existsSync(new URL('../lib/log.mjs', import.meta.url)), true)
})
