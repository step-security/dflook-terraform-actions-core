import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CloudError,
  DEFAULT_CLOUD_HOST,
  TerraformCloudClient,
  fetchCloudJsonPlan,
  getCliCredentials,
  readCliCredentials,
} from '../src/comment/terraform-cloud.js'

function configFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tfrc-')), '.terraformrc')
  writeFileSync(path, contents)
  return path
}

describe('reading tokens from the CLI config', () => {
  it('reads a single host', () => {
    expect(
      readCliCredentials('credentials "app.terraform.io" {\n  token = "abc123"\n}\n')
    ).toEqual({ 'app.terraform.io': 'abc123' })
  })

  it('reads several hosts', () => {
    const config = [
      'credentials "app.terraform.io" {',
      '  token = "cloud-token"',
      '}',
      'credentials "tfe.example.com" {',
      '  token = "enterprise-token"',
      '}',
    ].join('\n')

    expect(readCliCredentials(config)).toEqual({
      'app.terraform.io': 'cloud-token',
      'tfe.example.com': 'enterprise-token',
    })
  })

  it('ignores a block with no token', () => {
    expect(readCliCredentials('credentials "app.terraform.io" {\n  other = "x"\n}\n')).toEqual({})
  })

  it('ignores unrelated configuration', () => {
    const config = 'plugin_cache_dir = "/tmp/cache"\ndisable_checkpoint = true\n'
    expect(readCliCredentials(config)).toEqual({})
  })

  it('handles an empty file', () => {
    expect(readCliCredentials('')).toEqual({})
  })
})

describe('finding a token for a host', () => {
  it('returns the token', () => {
    const path = configFile('credentials "app.terraform.io" {\n  token = "abc"\n}\n')
    expect(getCliCredentials('app.terraform.io', path)).toBe('abc')
  })

  it('returns nothing for a host with no entry', () => {
    const path = configFile('credentials "app.terraform.io" {\n  token = "abc"\n}\n')
    expect(getCliCredentials('tfe.example.com', path)).toBeUndefined()
  })

  /**
   * The JSON plan is a convenience output. Failing the run because credentials
   * could not be read would be worse than not publishing it.
   */
  it('returns nothing when the file does not exist', () => {
    expect(getCliCredentials('app.terraform.io', '/definitely/absent/.terraformrc')).toBeUndefined()
  })
})

function client(responses: { status: number; body?: string }[]) {
  let call = 0
  const fetchImpl = (async () => {
    const response = responses[Math.min(call, responses.length - 1)]
    call += 1
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.body ?? '',
    }
  }) as unknown as typeof fetch
  return fetchImpl
}

describe('fetching the json plan', () => {
  it('returns the body', async () => {
    const tfc = new TerraformCloudClient({
      token: 't',
      fetchImpl: client([{ status: 200, body: '{"format_version":"1.2"}' }]),
    })
    await expect(tfc.getJsonPlan('run-abc')).resolves.toBe('{"format_version":"1.2"}')
  })

  it('requests the documented endpoint', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(String(url))
      return { ok: true, status: 200, text: async () => '{}' }
    }) as unknown as typeof fetch

    await new TerraformCloudClient({ token: 't', fetchImpl }).getJsonPlan('run-abc')
    expect(seen[0]).toBe('https://app.terraform.io/api/v2/runs/run-abc/plan/json-output')
  })

  it('honours a self-hosted host', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(String(url))
      return { ok: true, status: 200, text: async () => '{}' }
    }) as unknown as typeof fetch

    await new TerraformCloudClient({
      hostname: 'tfe.example.com',
      token: 't',
      fetchImpl,
    }).getJsonPlan('run-abc')
    expect(seen[0]).toContain('https://tfe.example.com/api/v2/')
  })

  /** The causes differ and so does the advice, so the codes are told apart. */
  it.each([
    [401, /unauthorized/i],
    [429, /rate limit/i],
    [500, /returned 500/],
  ])('reports %s distinctly', async (status, expected) => {
    const tfc = new TerraformCloudClient({ token: 't', fetchImpl: client([{ status }]) })
    await expect(tfc.getJsonPlan('run-abc')).rejects.toThrow(expected)
    await expect(tfc.getJsonPlan('run-abc')).rejects.toThrow(CloudError)
  })

  it('defaults to the public host', () => {
    expect(DEFAULT_CLOUD_HOST).toBe('app.terraform.io')
  })
})

/**
 * Never throws. The plan has already been produced by this point; only one
 * convenience output depends on this succeeding.
 */
describe('the best-effort wrapper', () => {
  it('returns the plan on success', async () => {
    const result = await fetchCloudJsonPlan({
      runId: 'run-abc',
      token: 't',
      fetchImpl: client([{ status: 200, body: '{"a":1}' }]),
    })
    expect(result).toEqual({ plan: '{"a":1}' })
  })

  it('reports a reason rather than throwing on a bad token', async () => {
    const result = await fetchCloudJsonPlan({
      runId: 'run-abc',
      token: 't',
      fetchImpl: client([{ status: 401 }]),
    })
    expect(result).toHaveProperty('reason')
    expect((result as { reason: string }).reason).toMatch(/unauthorized/i)
  })

  it('reports a reason when no token can be found', async () => {
    const result = await fetchCloudJsonPlan({
      runId: 'run-abc',
      configPath: '/definitely/absent/.terraformrc',
    })
    expect((result as { reason: string }).reason).toMatch(/No Terraform Cloud token/)
  })

  it('falls back to the CLI config for the token', async () => {
    const path = configFile('credentials "app.terraform.io" {\n  token = "from-file"\n}\n')
    const seen: string[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>).authorization))
      return { ok: true, status: 200, text: async () => '{}' }
    }) as unknown as typeof fetch

    await fetchCloudJsonPlan({ runId: 'run-abc', configPath: path, fetchImpl })
    expect(seen[0]).toBe('Bearer from-file')
  })

  it('prefers a token from the backend configuration', async () => {
    const path = configFile('credentials "app.terraform.io" {\n  token = "from-file"\n}\n')
    const seen: string[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>).authorization))
      return { ok: true, status: 200, text: async () => '{}' }
    }) as unknown as typeof fetch

    await fetchCloudJsonPlan({ runId: 'run-abc', token: 'explicit', configPath: path, fetchImpl })
    expect(seen[0]).toBe('Bearer explicit')
  })
})
/**
 * The config path is read from disk, so its size is not bounded by anything we
 * control. Scanning lines keeps this linear.
 */
describe('parsing cost', () => {
  it('handles a large file promptly', () => {
    const hostile = 'credentials "!"{{|'.repeat(20_000)
    const started = Date.now()
    readCliCredentials(hostile)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('handles a long single line promptly', () => {
    const started = Date.now()
    readCliCredentials(`credentials "${'a'.repeat(80_000)}`)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('still reads a token after other attributes', () => {
    const config = [
      'credentials "app.terraform.io" {',
      '  # a comment',
      '  token = "abc"',
      '}',
    ].join('\n')
    expect(readCliCredentials(config)).toEqual({ 'app.terraform.io': 'abc' })
  })

  it('does not leak a token across blocks', () => {
    const config = [
      'credentials "a.example" {',
      '}',
      'credentials "b.example" {',
      '  token = "only-b"',
      '}',
    ].join('\n')
    expect(readCliCredentials(config)).toEqual({ 'b.example': 'only-b' })
  })
})
