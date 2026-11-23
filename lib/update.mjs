/**
 * "Is there a newer version?" — shown in `/status`, never acted on.
 *
 * DSH can list and install newer plugin versions, but nothing tells the user one
 * exists: they would have to open Plugin Manager and look. This adds the missing
 * sentence to `/status`. It deliberately does not auto-update — an upgrade can break a
 * session that is in use, and DSH's own update path is explicit for the same reason.
 *
 * Rules: at most one registry request per day, cached on disk, every failure silent.
 * A version check must never slow down startup or break a turn.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { dshHome } from './github.mjs'

/** One check a day is enough; releases are not that frequent. */
const TTL_MS = 24 * 60 * 60 * 1000

/** How long the registry may take before the check gives up. */
const TIMEOUT_MS = 8_000

/**
 * A newer version notice, or '' when there is nothing to say.
 *
 * @param {{ version?: string, latest?: string }} info
 * @returns {string}
 */
export function updateNotice(info) {
  const version = String(info?.version ?? '').trim()
  const latest = String(info?.latest ?? '').trim()
  if (!version || !latest) return ''
  if (version === latest) return ''
  return `新版本：${latest} 可用（当前 ${version}）`
}

/**
 * Compare two dotted versions. Prerelease suffixes compare as "older than release".
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b
 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre] = String(value ?? '').split('-')
    return { parts: core.split('.').map((item) => Number(item) || 0), pre: pre ?? '' }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre < right.pre ? -1 : 1
}

/**
 * Read the versions this profile has cached, then refresh them if the cache is old.
 *
 * @param {object} input
 * @param {string} input.name package name on the registry
 * @param {string} input.version the running version
 * @param {string} [input.stateFile] cache location
 * @param {number} [input.now]
 * @param {typeof fetch} [input.fetchImpl] injectable for tests
 * @param {string} [input.registry]
 * @returns {Promise<{ version: string, latest: string, checkedAt: number }>}
 */
export async function refreshVersionCache({
  name, version, stateFile, now = Date.now(), fetchImpl = fetch, registry = 'https://registry.npmjs.org',
} = {}) {
  const base = { version: String(version ?? ''), latest: '', checkedAt: 0 }
  if (!name || !stateFile) return base

  let cached
  try {
    cached = JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch { /* first run */ }
  if (cached && Number(cached.checkedAt ?? 0) > 0 && now - Number(cached.checkedAt) < TTL_MS) {
    return { version: base.version, latest: String(cached.latest ?? ''), checkedAt: Number(cached.checkedAt) }
  }

  try {
    const response = await fetchImpl(`${registry}/${encodeURIComponent(name)}/latest`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return base
    const payload = await response.json()
    const latest = String(payload?.version ?? '').trim()
    if (!latest) return base
    const next = { version: base.version, latest, checkedAt: now }
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, JSON.stringify(next))
    } catch { /* the cache is an optimisation, not a requirement */ }
    return next
  } catch {
    return base
  }
}

/** Where the version cache lives for one plugin. */
export function versionCachePath(slug) {
  return join(dshHome(), `${slug}-update.json`)
}
