/**
 * Recognising a state lock failure.
 *
 * Terraform exits non-zero when it cannot take the state lock, the same as it
 * does for a broken configuration, so the two are only distinguishable by
 * reading the error text. Telling them apart matters: a lock failure is usually
 * transient and worth retrying, while a configuration error is not, and the
 * `failure-reason` output exists so a workflow can make that choice.
 */

/** Fields Terraform prints when it reports who holds the lock. */
export type LockInfo = Record<string, string>

const LOCK_FAILED = 'Error acquiring the state lock'
const LOCK_INFO_HEADING = 'Lock Info:'
// The field cannot start with whitespace or contain a colon. Written that way
// on purpose: with a lazy `.*?` the leading `\s+` and the field group both match
// spaces, so the engine tries every split between them on a line that has no
// colon, which is quadratic in the line length.
const FIELD = /^\s+(?<field>[^\s:][^:]*):\s+(?<value>.*)/

/**
 * Extracts the lock details from a command's stderr.
 *
 * Returns undefined when the failure was not a lock, which is the signal to
 * report an ordinary failure instead. An empty object is a meaningful result and
 * distinct from undefined: the lock did fail, but Terraform gave no detail about
 * who holds it.
 */
export function getLockInfo(stderr: string): LockInfo | undefined {
  let locked = false
  let inLockInfo = false
  const info: LockInfo = {}

  for (const line of stderr.split('\n')) {
    if (!locked) {
      if (line.includes(LOCK_FAILED)) locked = true
      continue
    }

    if (inLockInfo) {
      const match = FIELD.exec(line)
      // Terraform indents the fields under the heading. A line that does not
      // match is the end of the block, but scanning on is harmless and avoids
      // depending on exactly what follows.
      if (match?.groups) info[match.groups.field] = match.groups.value
    } else if (line.startsWith(LOCK_INFO_HEADING)) {
      inLockInfo = true
    }
  }

  return locked ? info : undefined
}

/** True when the failure was a state lock rather than anything else. */
export function isStateLocked(stderr: string): boolean {
  return getLockInfo(stderr) !== undefined
}
