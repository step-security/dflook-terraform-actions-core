import { Version, compareVersions } from './version.js'

/**
 * Terraform version constraints.
 *
 * A constraint is an operator plus a partial version: `>= 1.5`, `~> 1.5.0`,
 * `!= 1.4.2`, or a bare `1.5.7` meaning equality. Omitted components read as
 * zero when comparing.
 *
 * Two rules here are easy to get wrong and both are load-bearing:
 *
 * - **Every operator except `=` refuses pre-releases.** `>= 1.0` will not select
 *   1.6.0-rc1. A pre-release can only ever be chosen by asking for it exactly.
 * - **`~>` widens by one component from the right.** `~> 1.5.0` permits 1.5.x,
 *   `~> 1.5` permits 1.x from 1.5 up, and `~> 1` permits any major at or above 1
 *   — which is looser than the pessimistic operator implies elsewhere.
 */

export type ConstraintOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | '~>'

// `[\s\S]` rather than `.` on purpose. `.` does not match a newline, so on an
// input containing one the engine backtracks through every split of the
// preceding group looking for a match that cannot exist — quadratic in the
// length of the input. Whitespace is stripped before these are applied, so it is
// not reachable today, but that is a property of the caller rather than of the
// pattern, and it is not worth depending on.
const OPERATOR_AND_REST = /^([=!<>~]*)([\s\S]*)$/
const PARTIAL_VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([\s\S]*))?$/

/** Ordering used when constraints are sorted, mirroring upstream. */
const OPERATOR_ORDER: ConstraintOperator[] = ['<', '<=', '=', '~>', '>=', '>']

export class InvalidConstraint extends Error {}

export class Constraint {
  readonly operator: ConstraintOperator

  readonly major: number

  /** Undefined when the constraint omitted it, e.g. `~> 1`. */
  readonly minor: number | undefined

  readonly patch: number | undefined

  readonly preRelease: string

  constructor(constraint: string) {
    // Whitespace is insignificant, so '>= 1.5' and '>=1.5' are the same.
    const compact = constraint.replace(/\s/g, '')

    const split = OPERATOR_AND_REST.exec(compact)
    if (!split) throw new InvalidConstraint(`Invalid version constraint: ${constraint}`)

    this.operator = (split[1] || '=') as ConstraintOperator
    if (!OPERATOR_ORDER.includes(this.operator) && this.operator !== '!=') {
      throw new InvalidConstraint(`Invalid constraint operator: ${split[1]}`)
    }

    const parts = PARTIAL_VERSION.exec(split[2])
    if (!parts) throw new InvalidConstraint(`Invalid version constraint: ${constraint}`)

    this.major = Number(parts[1])
    this.minor = parts[2] === undefined ? undefined : Number(parts[2])
    this.patch = parts[3] === undefined ? undefined : Number(parts[3])
    this.preRelease = parts[4] ?? ''
  }

  toString(): string {
    let text = `${this.operator}${this.major}`
    if (this.minor !== undefined) text += `.${this.minor}`
    if (this.patch !== undefined) text += `.${this.patch}`
    if (this.preRelease) text += `-${this.preRelease}`
    return text
  }

  /** Compares a version against this constraint's version, omissions as zero. */
  private compare(version: Version): number {
    if (version.major !== this.major) return version.major - this.major
    if (version.minor !== (this.minor ?? 0)) return version.minor - (this.minor ?? 0)
    if (version.patch !== (this.patch ?? 0)) return version.patch - (this.patch ?? 0)

    if (version.preRelease < this.preRelease) return -1
    if (version.preRelease > this.preRelease) return 1
    return 0
  }

  isAllowed(version: Version): boolean {
    const order = this.compare(version)

    // Only an exact match may resolve to a pre-release.
    if (this.operator === '=') return order === 0
    if (version.preRelease) return false

    switch (this.operator) {
      case '!=':
        return order !== 0
      case '>':
        return order > 0
      case '>=':
        return order >= 0
      case '<':
        return order < 0
      case '<=':
        return order <= 0
      case '~>':
        if (this.minor === undefined) return version.major >= this.major
        if (this.patch === undefined) {
          return version.major === this.major && version.minor >= this.minor
        }
        return (
          version.major === this.major &&
          version.minor === this.minor &&
          version.patch >= this.patch
        )
      default:
        return false
    }
  }
}

/** Keeps only the versions permitted by every constraint. */
export function applyConstraints(
  versions: Iterable<Version>,
  constraints: Iterable<Constraint>
): Version[] {
  const all = [...constraints]
  return [...versions].filter((version) => all.every((constraint) => constraint.isAllowed(version)))
}

/**
 * Parses a comma-separated constraint expression.
 *
 * Unparseable clauses are dropped rather than thrown, matching how Terraform
 * tolerates expressions it cannot act on.
 */
export function parseConstraints(expression: string): Constraint[] {
  const constraints: Constraint[] = []

  for (const clause of expression.split(',')) {
    if (!clause.trim()) continue
    try {
      constraints.push(new Constraint(clause))
    } catch {
      // Ignored deliberately; see the note above.
    }
  }

  return constraints
}

export function sortConstraints(constraints: Iterable<Constraint>): Constraint[] {
  return [...constraints].sort((a, b) => {
    if (a.major !== b.major) return a.major - b.major
    if ((a.minor ?? 0) !== (b.minor ?? 0)) return (a.minor ?? 0) - (b.minor ?? 0)
    if ((a.patch ?? 0) !== (b.patch ?? 0)) return (a.patch ?? 0) - (b.patch ?? 0)

    if (a.preRelease !== b.preRelease) {
      if (a.preRelease === '') return 1
      if (b.preRelease === '') return -1
      return a.preRelease < b.preRelease ? -1 : 1
    }

    return OPERATOR_ORDER.indexOf(a.operator) - OPERATOR_ORDER.indexOf(b.operator)
  })
}

export { compareVersions }
