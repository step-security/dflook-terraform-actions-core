import { createHash } from 'crypto'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const find = jest.fn()
const extractZip = jest.fn()
const cacheDir = jest.fn()

jest.mock('@actions/tool-cache', () => ({ find, extractZip, cacheDir, downloadTool: jest.fn() }))
jest.mock('../src/terraform/platform', () => ({
  releasePlatform: () => 'linux',
  releaseArch: () => 'amd64',
  executableName: () => 'terraform',
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { acquireTerraform } = require('../src/terraform/download')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VerificationError } = require('../src/terraform/verify')

const VERSION = { toString: () => '1.15.9', product: 'Terraform' } as never
const ARCHIVE = 'terraform_1.15.9_linux_amd64.zip'

let served: Record<string, { body: Buffer | string; ok?: boolean; status?: number }> = {}

beforeEach(() => {
  jest.clearAllMocks()
  find.mockReturnValue('')
  extractZip.mockResolvedValue('/extracted')
  cacheDir.mockResolvedValue('/cached')

  process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), 'download-'))
  served = {}

  global.fetch = jest.fn(async (url: string) => {
    const match = Object.entries(served).find(([suffix]) => String(url).endsWith(suffix))
    if (!match) return { ok: false, status: 404 }

    const [, response] = match
    const body = response.body
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => (typeof body === 'string' ? body : body.toString('utf8')),
      // Uint8Array.from copies the exact bytes. Reaching for `body.buffer`
      // would hand back Node's whole shared pool for small Buffers, so the
      // digest would differ from what was served.
      arrayBuffer: async () =>
        Uint8Array.from(typeof body === 'string' ? Buffer.from(body) : body).buffer,
    }
  }) as unknown as typeof fetch
})

function serveGenuineRelease(contents = 'genuine terraform archive'): string {
  const digest = createHash('sha256').update(contents).digest('hex')
  served = {
    SHA256SUMS: { body: `${digest}  ${ARCHIVE}\n` },
    [ARCHIVE]: { body: Buffer.from(contents) },
  }
  return digest
}

describe('acquiring a release', () => {
  it('verifies the digest, then extracts', async () => {
    serveGenuineRelease()

    await expect(acquireTerraform(VERSION)).resolves.toContain('terraform')
    expect(extractZip).toHaveBeenCalled()
  })

  /**
   * Extraction is what would place untrusted code on the runner, so a digest
   * mismatch has to stop the download before it is unpacked — not after.
   */
  it('refuses to extract when the archive digest does not match', async () => {
    served = {
      SHA256SUMS: { body: `${'f'.repeat(64)}  ${ARCHIVE}\n` },
      [ARCHIVE]: { body: Buffer.from('tampered archive') },
    }

    await expect(acquireTerraform(VERSION)).rejects.toThrow(VerificationError)
    expect(extractZip).not.toHaveBeenCalled()
  })

  it('fails when the archive is missing from the sums file', async () => {
    served = {
      SHA256SUMS: { body: `${'a'.repeat(64)}  terraform_1.15.9_darwin_arm64.zip\n` },
    }

    await expect(acquireTerraform(VERSION)).rejects.toThrow(/not listed in the published checksums/)
    expect(extractZip).not.toHaveBeenCalled()
  })

  it('fails when the sums file cannot be fetched', async () => {
    served = { [ARCHIVE]: { body: Buffer.from('archive') } }

    await expect(acquireTerraform(VERSION)).rejects.toThrow(/SHA256SUMS/)
    expect(extractZip).not.toHaveBeenCalled()
  })

  it('reuses a cached version without touching the network', async () => {
    find.mockReturnValue('/opt/hostedtoolcache/terraform/1.15.9/amd64')

    await expect(acquireTerraform(VERSION)).resolves.toContain('terraform')
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
