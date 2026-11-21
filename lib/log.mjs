/**
 * JSONL diagnostics for the watchtower: `~/.dsh/repo-watch.log`.
 *
 * The plugin had no logger, and one early change copied the channel plugin's
 * `logInbound` call without its definition — so every path that tried to log threw
 * a ReferenceError. On a successful push that throw landed in the dispatch catch
 * and reported the send as failed, which made the queue retry it: duplicate pushes,
 * logged as errors. A logging call must therefore be unable to break a send, and
 * the file itself has to exist so the next outage is explainable.
 */
import { appendFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { dshHome } from './github.mjs'

/** Keep the file bounded: diagnostics are for the last failure, not an archive. */
const MAX_BYTES = 2 * 1024 * 1024

export function logPath() {
  return join(dshHome(), 'repo-watch.log')
}

/**
 * Append one record. Never throws: a broken log path must not break the poller.
 * @param {object} record `{ event, result, ... }`
 */
export function logRecord(record) {
  try {
    const path = logPath()
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`)
    } catch { /* first write */ }
    appendFileSync(path, `${JSON.stringify({ time: Date.now(), ...record })}\n`)
  } catch { /* diagnostics are best effort */ }
}
