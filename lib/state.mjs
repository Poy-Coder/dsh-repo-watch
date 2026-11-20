/**
 * The watchtower's memory: `~/.dsh/repo-watch.json`.
 *
 * GitHub keeps notifications for seven days and 300 items, so the state file is
 * the only long-lived record. It is plain JSON on purpose — a human can read it,
 * `repo_watch_status` can show it, and a corrupted file degrades to "start over"
 * instead of an exception.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { dshHome } from './github.mjs'

export const STATE_VERSION = 1
/** Done threads older than this are forgotten; the inbox stays bounded. */
export const DONE_TTL_MS = 90 * 24 * 60 * 60 * 1000
export const MAX_THREADS = 2000

export const statePath = (config = {}) =>
  String(config.stateFile ?? '').trim() || join(dshHome(), 'repo-watch.json')

/** @returns {{ version: number, watermark: number, threads: Record<string, object> }} */
export function emptyState() {
  return { version: STATE_VERSION, watermark: 0, threads: {} }
}

export function loadState(config = {}) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(config), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return emptyState()
    return {
      version: STATE_VERSION,
      watermark: Number(parsed.watermark ?? 0),
      threads: parsed.threads && typeof parsed.threads === 'object' ? parsed.threads : {},
    }
  } catch {
    return emptyState()
  }
}

/** Write through a temp file so a crash mid-write cannot truncate the state. */
export function saveState(config, state) {
  const path = statePath(config)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

export function pruneThreads(state, now = Date.now()) {
  const entries = Object.entries(state.threads)
  const kept = entries.filter(([, thread]) => {
    if (thread?.state !== 'done') return true
    return now - Number(thread.lastActivityAt ?? 0) <= DONE_TTL_MS
  })
  if (kept.length > MAX_THREADS) {
    kept.sort((a, b) => Number(b[1]?.lastActivityAt ?? 0) - Number(a[1]?.lastActivityAt ?? 0))
    kept.length = MAX_THREADS
  }
  state.threads = Object.fromEntries(kept)
  return state
}

/**
 * Record one judged thread, preserving the parts the judgement does not own.
 * @returns {{ changed: boolean, notify: boolean }}
 */
export function upsertThread(state, key, patch, { pending, notify }) {
  const previous = state.threads[key]
  const now = Date.now()
  const next = {
    ...(previous ?? {}),
    ...patch,
    state: pending ? 'pending' : (previous?.state ?? 'seen'),
    lastActivityAt: Number(patch.lastActivityAt ?? previous?.lastActivityAt ?? now),
  }
  if (!previous || previous.state !== next.state) next.stateSince = now
  if (notify) {
    next.notifiedAt = now
    next.notifyCount = Number(previous?.notifyCount ?? 0) + 1
  }
  state.threads[key] = next
  return { changed: JSON.stringify(previous) !== JSON.stringify(next), notify }
}

export function countsOf(state) {
  const counts = { pending: 0, seen: 0, done: 0 }
  for (const thread of Object.values(state.threads)) {
    const state_ = String(thread?.state ?? '')
    if (state_ in counts) counts[state_] += 1
  }
  return counts
}
