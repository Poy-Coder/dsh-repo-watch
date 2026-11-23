/**
 * The upgrade notice in `repo_watch_status`.
 *
 * DSH can install a newer plugin version but never says one exists, so the user has to
 * open Plugin Manager and compare versions by hand. This makes the answer one line in
 * a place they already look. It is a notice only — nothing updates itself.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compareVersions, refreshVersionCache, updateNotice } from '../lib/update.mjs'
import { readRunningVersion } from '../index.mjs'

const stateFile = () => join(mkdtempSync(join(tmpdir(), 'dsh-rw-update-')), 'update.json')

test('the notice only appears when there is something newer', () => {
  assert.equal(updateNotice({ version: '0.5.5', latest: '0.5.6' }), '新版本：0.5.6 可用（当前 0.5.5）')
  assert.equal(updateNotice({ version: '0.5.6', latest: '0.5.6' }), '')
  assert.equal(updateNotice({ version: '', latest: '0.5.6' }), '')
})

test('versions compare numerically', () => {
  assert.ok(compareVersions('0.5.9', '0.5.10') < 0)
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0)
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0)
})

test('the cache stops repeat lookups for a day', async () => {
  const file = stateFile()
  let calls = 0
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ version: '9.9.9' }) } }
  await refreshVersionCache({ name: 'dsh-repo-watch', version: '0.5.5', stateFile: file, fetchImpl })
  await refreshVersionCache({ name: 'dsh-repo-watch', version: '0.5.5', stateFile: file, fetchImpl })
  assert.equal(calls, 1)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).latest, '9.9.9')
})

test('the running version comes from the shipped manifest', () => {
  const version = readRunningVersion()
  assert.match(version, /^\d+\.\d+\.\d+/, `读到的版本不像版本号：${version}`)
})

test('a failure is silent', async () => {
  const file = stateFile()
  const failing = async () => { throw new Error('offline') }
  const result = await refreshVersionCache({ name: 'dsh-repo-watch', version: '0.5.5', stateFile: file, fetchImpl: failing })
  assert.equal(result.latest, '')
})
