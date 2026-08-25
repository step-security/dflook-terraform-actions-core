/**
 * The version model used throughout release selection.
 *
 * Terraform and OpenTofu both publish `major.minor.patch` with an optional
 * pre-release suffix. Ordering has one non-obvious rule: a release with no
 * pre-release suffix sorts *above* any pre-release of the same number, so
 * 1.6.0 is newer than 1.6.0-rc1. Suffixes themselves compare as plain strings,
 * which is what the upstream release channels rely on.
 */

export type Product = 'Terraform' | 'OpenTofu'

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([\d\w-]+))?/

export class InvalidVersion extends Error {}

export class Version {
  readonly major: number

  readonly minor: number

  readonly patch: number

  /** Empty string when this is a final release. */
  readonly preRelease: string

  readonly product: Product

  constructor(version: string, product: Product = 'Terraform') {
    const match = VERSION.exec(version)
    if (!match) throw new InvalidVersion(`Not a valid version: ${version}`)

    this.major = Number(match[1])
    this.minor = Number(match[2])
    this.patch = Number(match[3])
    this.preRelease = match[4] ?? ''
    this.product = product
  }

  toString(): string {
    const core = `${this.major}.${this.minor}.${this.patch}`
    return this.preRelease ? `${core}-${this.preRelease}` : core
  }

  equals(other: Version): boolean {
    return compareVersions(this, other) === 0
  }
}

/** Negative when a sorts before b, positive when after, zero when equal. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch

  if (a.preRelease === b.preRelease) return 0

  // A final release outranks any pre-release of the same number.
  if (a.preRelease === '') return 1
  if (b.preRelease === '') return -1

  return a.preRelease < b.preRelease ? -1 : 1
}

/** Ascending order. */
export function sortVersions(versions: Iterable<Version>): Version[] {
  return [...versions].sort(compareVersions)
}

/** Highest version, ignoring pre-releases. Undefined when there are none. */
export function latestFinalVersion(versions: Iterable<Version>): Version | undefined {
  const ordered = sortVersions(versions).reverse()
  return ordered.find((version) => !version.preRelease)
}

/** Highest version, pre-releases included. */
export function latestVersion(versions: Iterable<Version>): Version | undefined {
  return sortVersions(versions).pop()
}

/** Lowest version, ignoring pre-releases. */
export function earliestFinalVersion(versions: Iterable<Version>): Version | undefined {
  return sortVersions(versions).find((version) => !version.preRelease)
}

/** Lowest version, pre-releases included. */
export function earliestVersion(versions: Iterable<Version>): Version | undefined {
  return sortVersions(versions)[0]
}

/** Parses a version, returning undefined instead of throwing. */
export function tryParseVersion(value: string, product: Product = 'Terraform'): Version | undefined {
  try {
    return new Version(value.trim(), product)
  } catch {
    return undefined
  }
}
