import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  fromAsdf,
  fromEnvironment,
  fromLocalState,
  fromRequiredVersion,
  fromTfenv,
  fromTfswitch,
  parseToolVersions,
  parseTfenv,
} from '../src/version/sources'
import { loadModule } from '../src/terraform/module'
import { Version } from '../src/version/version'

const AVAILABLE = [
  '0.12.31',
  '0.13.5',
  '1.4.0',
  '1.5.0',
  '1.5.7',
  '1.6.0',
  '1.6.1-rc1',
  '2.0.0',
].map((text) => new Version(text))

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'sources-'))
}

function moduleWith(contents: string): string {
  const dir = scratch()
  writeFileSync(join(dir, 'main.tf'), contents)
  return dir
}

describe('required_version', () => {
  it('takes the newest final release matching the constraint', () => {
    const dir = moduleWith('terraform {\n  required_version = "~> 1.5"\n}\n')
    expect(fromRequiredVersion(loadModule(dir), AVAILABLE)?.toString()).toBe('1.6.0')
  })

  it('respects an upper bound', () => {
    const dir = moduleWith('terraform {\n  required_version = ">= 1.4, < 1.6"\n}\n')
    expect(fromRequiredVersion(loadModule(dir), AVAILABLE)?.toString()).toBe('1.5.7')
  })

  it('never selects a pre-release', () => {
    const dir = moduleWith('terraform {\n  required_version = ">= 1.6"\n}\n')
    expect(fromRequiredVersion(loadModule(dir), AVAILABLE)?.toString()).toBe('2.0.0')
  })

  it('says nothing when the module declares no constraint', () => {
    const dir = moduleWith('resource "null_resource" "a" {}\n')
    expect(fromRequiredVersion(loadModule(dir), AVAILABLE)).toBeUndefined()
  })

  /**
   * A constraint matching nothing is not fatal — it means this source cannot
   * answer, and resolution falls through to the next one.
   */
  it('says nothing when the constraint matches no available version', () => {
    const dir = moduleWith('terraform {\n  required_version = "~> 99.0"\n}\n')
    expect(fromRequiredVersion(loadModule(dir), AVAILABLE)).toBeUndefined()
  })
})

describe('.terraform-version (tfenv)', () => {
  it('reads a concrete version', () => {
    expect(parseTfenv('1.5.7\n', AVAILABLE)?.toString()).toBe('1.5.7')
  })

  it('resolves "latest" to the newest final release', () => {
    expect(parseTfenv('latest', AVAILABLE)?.toString()).toBe('2.0.0')
  })

  it('resolves "latest:REGEX" to the newest match', () => {
    expect(parseTfenv('latest:^1.5', AVAILABLE)?.toString()).toBe('1.5.7')
  })

  it('allows a pre-release through a latest: pattern', () => {
    expect(parseTfenv('latest:^1.6', AVAILABLE)?.toString()).toBe('1.6.1-rc1')
  })

  it('says nothing when a latest: pattern matches nothing', () => {
    expect(parseTfenv('latest:^99', AVAILABLE)).toBeUndefined()
  })

  /**
   * The file is an instruction rather than a suggestion, so a version we have
   * not seen in the index is still honoured; the download reports it if it does
   * not exist.
   */
  it('honours a version that is not in the available list', () => {
    expect(parseTfenv('1.9.9', AVAILABLE)?.toString()).toBe('1.9.9')
  })

  it('ignores an unusable value', () => {
    expect(parseTfenv('not-a-version', AVAILABLE)).toBeUndefined()
    expect(parseTfenv('', AVAILABLE)).toBeUndefined()
  })

  it('says nothing when the file is absent', () => {
    expect(fromTfenv(scratch(), '.terraform-version', AVAILABLE)).toBeUndefined()
  })

  it('reads the file from the module directory', () => {
    const dir = scratch()
    writeFileSync(join(dir, '.terraform-version'), '1.5.0\n')
    expect(fromTfenv(dir, '.terraform-version', AVAILABLE)?.toString()).toBe('1.5.0')
  })
})

describe('.tfswitchrc', () => {
  it('reads a bare version', () => {
    const dir = scratch()
    writeFileSync(join(dir, '.tfswitchrc'), '1.5.7\n')
    expect(fromTfswitch(dir)?.toString()).toBe('1.5.7')
  })

  it('ignores an unusable value', () => {
    const dir = scratch()
    writeFileSync(join(dir, '.tfswitchrc'), 'latest\n')
    expect(fromTfswitch(dir)).toBeUndefined()
  })

  it('says nothing when absent', () => {
    expect(fromTfswitch(scratch())).toBeUndefined()
  })
})

describe('.tool-versions (asdf)', () => {
  it('reads the terraform entry', () => {
    expect(parseToolVersions('nodejs 20.0.0\nterraform 1.5.7\n', AVAILABLE)?.toString()).toBe('1.5.7')
  })

  it('ignores other tools', () => {
    expect(parseToolVersions('nodejs 20.0.0\npython 3.12.0\n', AVAILABLE)).toBeUndefined()
  })

  it('resolves latest', () => {
    expect(parseToolVersions('terraform latest\n', AVAILABLE)?.toString()).toBe('2.0.0')
  })

  it('stops at a trailing comment', () => {
    expect(parseToolVersions('terraform 1.5.0 # pinned\n', AVAILABLE)?.toString()).toBe('1.5.0')
  })

  /** asdf resolves upwards, so a file at the repository root covers every module. */
  it('walks up from the module to the workspace root', () => {
    const root = scratch()
    const module = join(root, 'infra', 'prod')
    mkdirSync(module, { recursive: true })
    writeFileSync(join(root, '.tool-versions'), 'terraform 1.5.7\n')

    expect(fromAsdf(module, root, AVAILABLE)?.toString()).toBe('1.5.7')
  })

  it('prefers the nearest file when several exist', () => {
    const root = scratch()
    const module = join(root, 'infra')
    mkdirSync(module, { recursive: true })
    writeFileSync(join(root, '.tool-versions'), 'terraform 1.4.0\n')
    writeFileSync(join(module, '.tool-versions'), 'terraform 1.5.7\n')

    expect(fromAsdf(module, root, AVAILABLE)?.toString()).toBe('1.5.7')
  })

  it('does not look above the workspace root', () => {
    const outer = scratch()
    const root = join(outer, 'repo')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(outer, '.tool-versions'), 'terraform 1.4.0\n')

    expect(fromAsdf(root, root, AVAILABLE)).toBeUndefined()
  })
})

describe('environment variables', () => {
  it('reads TERRAFORM_VERSION as a constraint', () => {
    // `~>` refuses pre-releases, so 1.6.1-rc1 is not eligible here even though
    // it is numerically the highest match.
    const result = fromEnvironment({ TERRAFORM_VERSION: '~> 1.5' }, AVAILABLE)
    expect(result.version?.toString()).toBe('1.6.0')
    expect(result.variable).toBe('TERRAFORM_VERSION')
  })

  it('accepts an exact version', () => {
    expect(fromEnvironment({ TERRAFORM_VERSION: '1.5.0' }, AVAILABLE).version?.toString()).toBe(
      '1.5.0'
    )
  })

  /**
   * Unlike the constraint-based file sources, this one includes pre-releases —
   * which is the only way to ask for something like 1.6.0-alpha3.
   */
  it('can select a pre-release by asking for it exactly', () => {
    expect(
      fromEnvironment({ OPENTOFU_VERSION: '1.6.1-rc1' }, AVAILABLE).version?.toString()
    ).toBe('1.6.1-rc1')
  })

  it('prefers TERRAFORM_VERSION when both are set', () => {
    const result = fromEnvironment(
      { TERRAFORM_VERSION: '1.5.0', OPENTOFU_VERSION: '1.6.0' },
      AVAILABLE
    )
    expect(result.variable).toBe('TERRAFORM_VERSION')
    expect(result.version?.toString()).toBe('1.5.0')
  })

  it('says nothing when neither is set', () => {
    expect(fromEnvironment({}, AVAILABLE)).toEqual({})
  })

  it('reports a constraint that matches nothing, so it can be logged', () => {
    const result = fromEnvironment({ TERRAFORM_VERSION: '~> 99.0' }, AVAILABLE)
    expect(result.version).toBeUndefined()
    expect(result.unmatchedConstraint).toBe('~> 99.0')
  })
})

describe('local terraform.tfstate', () => {
  it('reads the version that wrote the state', () => {
    const dir = scratch()
    writeFileSync(
      join(dir, 'terraform.tfstate'),
      JSON.stringify({ serial: 3, terraform_version: '1.5.7' })
    )
    expect(fromLocalState(dir)?.toString()).toBe('1.5.7')
  })

  /** serial 0 means nothing has been applied, so the version proves nothing. */
  it('ignores state that has never been written', () => {
    const dir = scratch()
    writeFileSync(
      join(dir, 'terraform.tfstate'),
      JSON.stringify({ serial: 0, terraform_version: '1.5.7' })
    )
    expect(fromLocalState(dir)).toBeUndefined()
  })

  it('attributes the version to OpenTofu when that is what we are running', () => {
    const dir = scratch()
    writeFileSync(
      join(dir, 'terraform.tfstate'),
      JSON.stringify({ serial: 1, terraform_version: '1.6.0' })
    )
    expect(fromLocalState(dir, true)?.product).toBe('OpenTofu')
    expect(fromLocalState(dir, false)?.product).toBe('Terraform')
  })

  it('ignores malformed state', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'terraform.tfstate'), 'not json')
    expect(fromLocalState(dir)).toBeUndefined()
  })

  it('says nothing when there is no state file', () => {
    expect(fromLocalState(scratch())).toBeUndefined()
  })
})
