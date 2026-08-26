import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { backendFingerprint, canonicalJson } from '../src/comment/backend-fingerprint.js'

const NO_ENV = {} as NodeJS.ProcessEnv

/**
 * The fingerprint bytes are hashed, so this has to agree with Python's
 * canonicaljson exactly. Any difference in key order or spacing produces a
 * different hash and silently stops comments from matching.
 *
 * These expectations came from running canonicaljson, not from reading its docs.
 */
describe('parity with canonicaljson', () => {
  const cases = require('./fixtures/canonical-json-parity.json') as {
    name: string
    value: unknown
    canonical: string
  }[]

  it('has cases to compare', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  it.each(cases.map((c) => [c.name, c] as const))('matches on %s', (_name, testCase) => {
    expect(canonicalJson(testCase.value)).toBe(testCase.canonical)
  })
})

describe('canonical encoding', () => {
  it('sorts keys', () => {
    expect(canonicalJson({ b: '1', a: '2' })).toBe('{"a":"2","b":"1"}')
  })

  it('uses no whitespace', () => {
    expect(canonicalJson({ a: '1', b: '2' })).not.toContain(' ')
  })

  /** null and empty string encode differently, and the difference matters. */
  it('keeps null distinct from an empty string', () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({ a: '' }))
  })
})

describe('identifying an s3 backend', () => {
  const s3 = (config: Record<string, string>, env = NO_ENV) =>
    backendFingerprint({ backendType: 's3', config, env, modulePath: '/ws/infra' })

  it('distinguishes two buckets', () => {
    expect(s3({ bucket: 'a', key: 'terraform.tfstate' })).not.toBe(
      s3({ bucket: 'b', key: 'terraform.tfstate' })
    )
  })

  /**
   * The case the fingerprint exists for. Two modules in one pull request sharing
   * a bucket but not a key must not match, or a plan for one could approve an
   * apply of the other.
   */
  it('distinguishes two keys in the same bucket', () => {
    expect(s3({ bucket: 'shared', key: 'a.tfstate' })).not.toBe(
      s3({ bucket: 'shared', key: 'b.tfstate' })
    )
  })

  /** Region says how the bucket is reached, not which state file it holds. */
  it('ignores settings that do not identify the state', () => {
    expect(s3({ bucket: 'a', key: 'k', region: 'eu-west-1' })).toBe(
      s3({ bucket: 'a', key: 'k', region: 'us-east-1' })
    )
  })

  it('falls back to the environment for the endpoint', () => {
    expect(s3({ bucket: 'a' }, { AWS_S3_ENDPOINT: 'https://minio' } as NodeJS.ProcessEnv)).toBe(
      s3({ bucket: 'a', endpoint: 'https://minio' })
    )
  })

  it('prefers the config over the environment', () => {
    expect(
      s3({ bucket: 'a', endpoint: 'https://explicit' }, {
        AWS_S3_ENDPOINT: 'https://from-env',
      } as NodeJS.ProcessEnv)
    ).toBe(s3({ bucket: 'a', endpoint: 'https://explicit' }))
  })
})

describe('identifying a local backend', () => {
  it('uses the module path when no path is configured', () => {
    const a = backendFingerprint({
      backendType: 'local',
      config: {},
      env: NO_ENV,
      modulePath: '/ws/a',
    })
    const b = backendFingerprint({
      backendType: 'local',
      config: {},
      env: NO_ENV,
      modulePath: '/ws/b',
    })
    expect(a).not.toBe(b)
  })

  it('includes workspace_dir only when set', () => {
    const without = backendFingerprint({
      backendType: 'local',
      config: { path: 'p' },
      env: NO_ENV,
      modulePath: '/ws',
    })
    expect(without).not.toContain('workspace_dir')

    const with_ = backendFingerprint({
      backendType: 'local',
      config: { path: 'p', workspace_dir: 'd' },
      env: NO_ENV,
      modulePath: '/ws',
    })
    expect(with_).toContain('workspace_dir')
  })
})

describe('endpoint lists', () => {
  /** Reordering the same endpoints is not a different backend. */
  it('sorts etcd endpoints so order does not matter', () => {
    const a = backendFingerprint({
      backendType: 'etcd',
      config: { path: 'p', endpoints: 'b.example a.example' },
      env: NO_ENV,
      modulePath: '/ws',
    })
    const b = backendFingerprint({
      backendType: 'etcd',
      config: { path: 'p', endpoints: 'a.example b.example' },
      env: NO_ENV,
      modulePath: '/ws',
    })
    expect(a).toBe(b)
  })
})

describe('an unrecognised backend', () => {
  /**
   * Falling back to the whole config errs towards changing too often, which
   * creates a new comment rather than matching the wrong one.
   */
  it('fingerprints the whole config', () => {
    const fingerprint = backendFingerprint({
      backendType: 'some_future_backend',
      config: { anything: 'here' },
      env: NO_ENV,
      modulePath: '/ws',
    })
    expect(fingerprint).toBe('{"anything":"here"}')
  })
})

/**
 * Terraform records the backend it actually initialised. Where that disagrees
 * with the configuration, the initialised value is what is really in use, so a
 * partial config completed at init time must fingerprint the same as the
 * completed one.
 */
describe('the initialised backend', () => {
  function dataDirWith(backend: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'datadir-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'terraform.tfstate'), JSON.stringify({ backend }))
    return dir
  }

  it('overrides a configured value', () => {
    const dataDir = dataDirWith({ type: 's3', config: { bucket: 'real-bucket' } })

    const withState = backendFingerprint({
      backendType: 's3',
      config: { bucket: 'partial', key: 'k' },
      env: NO_ENV,
      modulePath: '/ws',
      dataDir,
    })

    expect(withState).toContain('real-bucket')
    expect(withState).not.toContain('partial')
  })

  it('ignores a state file for a different backend type', () => {
    const dataDir = dataDirWith({ type: 'gcs', config: { bucket: 'other' } })

    const fingerprint = backendFingerprint({
      backendType: 's3',
      config: { bucket: 'configured', key: 'k' },
      env: NO_ENV,
      modulePath: '/ws',
      dataDir,
    })

    expect(fingerprint).toContain('configured')
  })

  it('does not add fields the configuration does not have', () => {
    const dataDir = dataDirWith({ type: 's3', config: { bucket: 'b', unrelated: 'x' } })

    const fingerprint = backendFingerprint({
      backendType: 's3',
      config: { bucket: 'b' },
      env: NO_ENV,
      modulePath: '/ws',
      dataDir,
    })

    expect(fingerprint).not.toContain('unrelated')
  })

  /** An unreadable state file is not a reason to fail the run. */
  it('tolerates an unparseable state file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'datadir-'))
    writeFileSync(join(dir, 'terraform.tfstate'), 'not json at all')

    expect(() =>
      backendFingerprint({
        backendType: 's3',
        config: { bucket: 'b' },
        env: NO_ENV,
        modulePath: '/ws',
        dataDir: dir,
      })
    ).not.toThrow()
  })

  it('tolerates a missing state file', () => {
    expect(() =>
      backendFingerprint({
        backendType: 's3',
        config: { bucket: 'b' },
        env: NO_ENV,
        modulePath: '/ws',
        dataDir: join(tmpdir(), 'definitely-absent'),
      })
    ).not.toThrow()
  })
})
