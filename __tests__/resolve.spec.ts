import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Constraint } from '../src/version/constraint'
import { candidateVersions, resolveVersion } from '../src/version/resolve'
import { Version } from '../src/version/version'
import { loadModule } from '../src/terraform/module'

/**
 * Architecture is mocked so results do not depend on the machine running the
 * tests: resolution applies an arm64-specific constraint, which would otherwise
 * make these cases pass on x86 and fail on Apple Silicon.
 */
let currentArch = 'amd64'
jest.mock('../src/terraform/platform', () => ({
  releaseArch: () => currentArch,
  releasePlatform: () => 'linux',
  executableName: () => 'terraform',
}))

const AVAILABLE = ['0.12.31', '1.4.0', '1.5.0', '1.5.7', '1.6.0', '2.0.0'].map(
  (t) => new Version(t)
)

function scratch(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-'))
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents)
  }
  return dir
}

function resolve(
  dir: string,
  env: Record<string, string | undefined> = {},
  extra: Partial<Parameters<typeof resolveVersion>[1]> = {}
) {
  return resolveVersion(
    { modulePath: dir, workspaceRoot: dir },
    { module: loadModule(dir), versions: AVAILABLE, env, ...extra }
  )
}

describe('precedence', () => {
  /**
   * Every source is present at once, so each case removes the winner and checks
   * that the next one down takes over. This is the ordering that decides which
   * binary runs, so it is pinned explicitly rather than inferred.
   */
  const allSources = {
    'main.tf': 'terraform {\n  required_version = "1.5.0"\n}\n',
    '.tfswitchrc': '1.5.7\n',
    '.terraform-version': '1.4.0\n',
    '.tool-versions': 'terraform 0.12.31\n',
  }

  it('puts the remote workspace above everything', () => {
    const dir = scratch(allSources)
    const result = resolve(dir, { TERRAFORM_VERSION: '2.0.0' }, {
      remoteWorkspaceVersion: () => new Version('1.6.0'),
    })
    expect(result?.version.toString()).toBe('1.6.0')
    expect(result?.reason).toMatch(/remote workspace/)
  })

  it('puts required_version above the files and the environment', () => {
    const dir = scratch(allSources)
    const result = resolve(dir, { TERRAFORM_VERSION: '2.0.0' })
    expect(result?.version.toString()).toBe('1.5.0')
    expect(result?.reason).toMatch(/required_version/)
  })

  it('falls to .tfswitchrc when there is no required_version', () => {
    const { 'main.tf': _ignored, ...rest } = allSources
    const result = resolve(scratch(rest), { TERRAFORM_VERSION: '2.0.0' })
    expect(result?.version.toString()).toBe('1.5.7')
    expect(result?.reason).toMatch(/\.tfswitchrc/)
  })

  it('falls to .terraform-version next', () => {
    const result = resolve(
      scratch({ '.terraform-version': '1.4.0\n', '.tool-versions': 'terraform 0.12.31\n' }),
      { TERRAFORM_VERSION: '2.0.0' }
    )
    expect(result?.version.toString()).toBe('1.4.0')
    expect(result?.reason).toMatch(/\.terraform-version/)
  })

  it('falls to .tool-versions next', () => {
    const result = resolve(scratch({ '.tool-versions': 'terraform 0.12.31\n' }), {
      TERRAFORM_VERSION: '2.0.0',
    })
    expect(result?.version.toString()).toBe('0.12.31')
    expect(result?.reason).toMatch(/\.tool-versions/)
  })

  /**
   * The environment variable is seventh, not first. A configuration's
   * required_version states what the code needs; the variable states only what
   * the workflow would prefer.
   */
  it('only reaches the environment variable once every file is absent', () => {
    const result = resolve(scratch(), { TERRAFORM_VERSION: '1.5.7' })
    expect(result?.version.toString()).toBe('1.5.7')
    expect(result?.reason).toMatch(/TERRAFORM_VERSION/)
  })

  it('uses the newest release when nothing specifies anything', () => {
    const result = resolve(scratch())
    expect(result?.version.toString()).toBe('2.0.0')
    expect(result?.reason).toMatch(/newest release/)
  })
})

describe('state as a source', () => {
  it('reads local state when the backend is local', () => {
    const dir = scratch({
      'terraform.tfstate': JSON.stringify({ serial: 2, terraform_version: '1.4.0' }),
    })
    const result = resolve(dir)
    expect(result?.version.toString()).toBe('1.4.0')
    expect(result?.reason).toMatch(/local terraform.tfstate/)
  })

  it('consults remote state for a backend that can be inspected', () => {
    const dir = scratch({ 'main.tf': 'terraform {\n  backend "s3" {}\n}\n' })
    const result = resolve(dir, {}, { remoteStateVersion: () => new Version('1.5.0') })
    expect(result?.version.toString()).toBe('1.5.0')
    expect(result?.reason).toMatch(/existing remote state/)
  })

  /** A remote or cloud backend is asked directly, so state is not inspected. */
  it('does not inspect state for a remote backend', () => {
    const dir = scratch({ 'main.tf': 'terraform {\n  backend "remote" {}\n}\n' })
    const probe = jest.fn(() => new Version('1.5.0'))
    const result = resolve(dir, {}, { remoteStateVersion: probe })

    expect(probe).not.toHaveBeenCalled()
    expect(result?.version.toString()).toBe('2.0.0')
  })
})

describe('constraints applied during resolution', () => {
  it('honours constraints imposed by the backend', () => {
    const dir = scratch({ 'main.tf': 'terraform {\n  backend "s3" {}\n}\n' })
    const result = resolve(dir, {}, { backendConstraints: () => [new Constraint('<1.6.0')] })
    expect(result?.version.toString()).toBe('1.5.7')
  })

  /** key=value backend config needs a version that supports the flag. */
  it('rules out releases predating key=value backend config', () => {
    currentArch = 'amd64'
    const result = resolveVersion(
      { modulePath: scratch(), workspaceRoot: '/', backendConfig: 'bucket=example' },
      {
        module: { body: '', files: [] },
        versions: [new Version('0.9.0'), new Version('0.9.1')],
        env: {},
      }
    )
    expect(result?.version.toString()).toBe('0.9.1')
  })

  /**
   * arm64 builds only exist from 0.13.5, so on that architecture older releases
   * are not selectable at all even when nothing else rules them out.
   */
  it('rules out releases with no arm64 build when running on arm64', () => {
    currentArch = 'arm64'
    try {
      const result = resolveVersion(
        { modulePath: scratch(), workspaceRoot: '/' },
        {
          module: { body: '', files: [] },
          versions: [new Version('0.12.31'), new Version('0.13.5')],
          env: {},
        }
      )
      expect(result?.version.toString()).toBe('0.13.5')
    } finally {
      currentArch = 'amd64'
    }
  })

  it('keeps older releases available on amd64', () => {
    currentArch = 'amd64'
    const result = resolveVersion(
      { modulePath: scratch(), workspaceRoot: '/' },
      { module: { body: '', files: [] }, versions: [new Version('0.12.31')], env: {} }
    )
    expect(result?.version.toString()).toBe('0.12.31')
  })

  it('returns nothing when constraints exclude every candidate', () => {
    const result = resolveVersion(
      { modulePath: scratch(), workspaceRoot: '/' },
      {
        module: { body: '', files: [] },
        versions: AVAILABLE,
        env: {},
        backendConstraints: () => [new Constraint('>=99.0')],
      }
    )
    expect(result).toBeUndefined()
  })
})

describe('candidate set', () => {
  const tofu = ['1.6.0', '1.7.0'].map((t) => new Version(t, 'OpenTofu'))

  it('is Terraform alone when OpenTofu is not selected', () => {
    expect(candidateVersions(AVAILABLE, undefined)).toHaveLength(AVAILABLE.length)
  })

  /**
   * The projects diverged at 1.6.0, so with OpenTofu selected Terraform is
   * capped below that and OpenTofu's own releases take over above it.
   */
  it('caps Terraform below 1.6.0 and adds OpenTofu', () => {
    const candidates = candidateVersions(AVAILABLE, tofu)
    const terraform = candidates.filter((v) => v.product === 'Terraform').map(String)

    expect(terraform).not.toContain('1.6.0')
    expect(terraform).not.toContain('2.0.0')
    expect(terraform).toContain('1.5.7')
    expect(candidates.filter((v) => v.product === 'OpenTofu')).toHaveLength(2)
  })
})
