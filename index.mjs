/**
 * dsh-repo-watch — name-reservation release.
 *
 * 0.0.1 publishes the package name and the bundle manifest only. The watchtower
 * itself (poller, state machine, digests) lands in 0.1.0. Installing this version
 * is harmless: it registers nothing and schedules nothing.
 */
export const name = 'repo-watch'

export function apply() {
  // Intentionally empty until 0.1.0.
}
