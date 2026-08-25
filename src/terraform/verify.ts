import { createHash } from 'crypto'
import { readFileSync } from 'fs'

/**
 * Verifying that a downloaded release is genuine.
 *
 * There are two independent steps and the order matters. The checksums file is
 * signed by HashiCorp, so it is verified first; only then is the archive checked
 * against it. Checking the archive against an unverified sums file would prove
 * nothing, since whoever supplied a bad archive could supply matching sums.
 *
 * Nothing here reaches the network or the filesystem beyond reading a given
 * path, which keeps the logic that decides whether a binary runs directly
 * testable.
 */

/** HashiCorp's release signing key. */
export const HASHICORP_SIGNING_KEY = 'C874011F0AB405110D02105534365D9472D7468F'

/** Short key id used in the signature filename HashiCorp publishes. */
export const HASHICORP_KEY_SUFFIX = '72D7468F'

export class VerificationError extends Error {}

/**
 * Extracts the digest for one archive from a `SHA256SUMS` file.
 *
 * The filename must match exactly. A substring match would let the line for
 * `terraform_1.2.3_linux_amd64.zip.sig` satisfy a lookup for the archive
 * itself.
 */
export function digestFor(sums: string, archiveName: string): string {
  for (const line of sums.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length !== 2) continue

    const [digest, name] = parts
    if (name !== archiveName) continue

    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new VerificationError(`Malformed SHA256 for ${archiveName}: '${digest}'`)
    }
    return digest
  }

  throw new VerificationError(`${archiveName} is not listed in the published checksums`)
}

/** SHA256 of a file, as lowercase hex. */
export function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Throws unless the file on disk matches the expected digest.
 *
 * Must be called before the archive is extracted or executed.
 */
export function assertDigest(path: string, archiveName: string, expected: string): void {
  const actual = sha256OfFile(path)
  if (actual === expected) return

  throw new VerificationError(
    `Checksum mismatch for ${archiveName}: expected ${expected}, got ${actual}. ` +
      'The download was not used.'
  )
}
