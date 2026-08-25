import { createHash } from 'crypto'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  VerificationError,
  assertDigest,
  digestFor,
  sha256OfFile,
} from '../src/terraform/verify.js'

const ARCHIVE = 'terraform_1.15.9_linux_amd64.zip'

function fileWith(contents: string): { path: string; digest: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'verify-')), ARCHIVE)
  writeFileSync(path, contents)
  return { path, digest: createHash('sha256').update(contents).digest('hex') }
}

describe('extracting a digest from a sums file', () => {
  const sums = [
    `${'a'.repeat(64)}  terraform_1.15.9_darwin_arm64.zip`,
    `${'b'.repeat(64)}  ${ARCHIVE}`,
  ].join('\n')

  it('finds the requested archive', () => {
    expect(digestFor(sums, ARCHIVE)).toBe('b'.repeat(64))
  })

  it('tolerates blank and trailing lines', () => {
    expect(digestFor(`\n${sums}\n\n`, ARCHIVE)).toBe('b'.repeat(64))
  })

  /**
   * A substring match would let the line for a detached signature satisfy a
   * lookup for the archive it signs.
   */
  it('will not match a filename that only shares a prefix', () => {
    expect(() => digestFor(`${'c'.repeat(64)}  ${ARCHIVE}.sig`, ARCHIVE)).toThrow(VerificationError)
  })

  it('rejects a malformed digest rather than trusting it', () => {
    expect(() => digestFor(`not-hex  ${ARCHIVE}`, ARCHIVE)).toThrow(/Malformed SHA256/)
  })

  it('rejects a digest of the wrong length', () => {
    expect(() => digestFor(`${'a'.repeat(63)}  ${ARCHIVE}`, ARCHIVE)).toThrow(/Malformed SHA256/)
  })

  it('throws when the archive is absent', () => {
    expect(() => digestFor(sums, 'terraform_1.15.9_solaris_sparc.zip')).toThrow(VerificationError)
  })

  it('throws on an empty file', () => {
    expect(() => digestFor('', ARCHIVE)).toThrow(VerificationError)
  })
})

describe('hashing', () => {
  it('agrees with an independently computed digest', () => {
    const { path, digest } = fileWith('release bytes')
    expect(sha256OfFile(path)).toBe(digest)
  })

  it('differs for differing contents', () => {
    expect(sha256OfFile(fileWith('one').path)).not.toBe(sha256OfFile(fileWith('two').path))
  })
})

describe('asserting an archive digest', () => {
  it('passes for a matching archive', () => {
    const { path, digest } = fileWith('genuine')
    expect(() => assertDigest(path, ARCHIVE, digest)).not.toThrow()
  })

  it('throws for an altered archive', () => {
    const { path } = fileWith('tampered')
    expect(() => assertDigest(path, ARCHIVE, 'f'.repeat(64))).toThrow(VerificationError)
  })

  it('reports both digests so the mismatch is diagnosable', () => {
    const { path, digest } = fileWith('tampered')
    expect(() => assertDigest(path, ARCHIVE, 'f'.repeat(64))).toThrow(
      new RegExp(`expected ${'f'.repeat(64)}, got ${digest}`)
    )
  })

  it('says the download was discarded', () => {
    expect(() => assertDigest(fileWith('x').path, ARCHIVE, 'f'.repeat(64))).toThrow(/was not used/)
  })

  it('is case sensitive, so an uppercase digest does not pass', () => {
    const { path, digest } = fileWith('genuine')
    expect(() => assertDigest(path, ARCHIVE, digest.toUpperCase())).toThrow(VerificationError)
  })
})
