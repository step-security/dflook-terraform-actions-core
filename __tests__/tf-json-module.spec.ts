import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { readModuleBackendConfig } from '../src/comment/backend-config.js'
import {
  filesInModule,
  getBackendType,
  getRequiredVersionExpression,
  getSensitiveVariables,
  isJsonModuleFile,
  loadModule,
} from '../src/terraform/module.js'

function moduleDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tf-json-module-'))
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body)
  }
  return dir
}

const S3_HCL = `
terraform {
  required_version = ">= 1.5"
  backend "s3" {
    bucket = "b"
    key    = "k"
    region = "eu-west-1"
  }
}

variable "api_token" {
  type      = string
  sensitive = true
}

variable "plain" {
  type = string
}
`

const S3_JSON = JSON.stringify({
  terraform: { required_version: '>= 1.5', backend: { s3: { bucket: 'b', key: 'k', region: 'eu-west-1' } } },
  variable: { api_token: { type: 'string', sensitive: true }, plain: { type: 'string' } },
})

describe('isJsonModuleFile', () => {
  it('recognises both JSON module suffixes', () => {
    expect(isJsonModuleFile('main.tf.json')).toBe(true)
    expect(isJsonModuleFile('main.tofu.json')).toBe(true)
  })

  it('does not claim ordinary files', () => {
    for (const name of ['main.tf', 'main.tofu', 'data.json', 'main.tf.json.bak']) {
      expect(isJsonModuleFile(name)).toBe(false)
    }
  })
})

describe('filesInModule', () => {
  it('reads .tf.json alongside .tf', () => {
    const dir = moduleDir({ 'main.tf': '', 'extra.tf.json': '{}', 'notes.md': '' })

    expect(filesInModule(dir).map((f) => basename(f)).sort()).toEqual(['extra.tf.json', 'main.tf'])
  })

  it('ignores .tofu.json unless OpenTofu is selected', () => {
    const dir = moduleDir({ 'main.tf.json': '{}', 'main.tofu.json': '{}' })

    expect(filesInModule(dir).map((f) => basename(f))).toEqual(['main.tf.json'])
  })

  it('lets .tofu.json override .tf.json under OpenTofu', () => {
    const dir = moduleDir({ 'main.tf.json': '{}', 'main.tofu.json': '{}' })

    expect(filesInModule(dir, true).map((f) => basename(f))).toEqual(['main.tofu.json'])
  })

  it('does not let a JSON file override the HCL file of the same name', () => {
    // `main.tf` and `main.tf.json` are different files to Terraform and both
    // are read; only the tofu variants replace their tf counterparts.
    const dir = moduleDir({ 'main.tf': '', 'main.tf.json': '{}' })

    expect(filesInModule(dir, true).map((f) => basename(f)).sort()).toEqual([
      'main.tf',
      'main.tf.json',
    ])
  })

  it('still lets .tofu override .tf', () => {
    const dir = moduleDir({ 'main.tf': '', 'main.tofu': '' })

    expect(filesInModule(dir, true).map((f) => basename(f))).toEqual(['main.tofu'])
  })
})

describe('loadModule with JSON files', () => {
  it('collects facts from a JSON module', () => {
    const module = loadModule(moduleDir({ 'main.tf.json': S3_JSON }))

    expect(module.json).toHaveLength(1)
    expect(getRequiredVersionExpression(module)).toBe('>= 1.5')
    expect(getBackendType(module)).toBe('s3')
    expect(getSensitiveVariables(module)).toEqual(['api_token'])
  })

  it('drops a JSON file that does not parse, keeping the rest', () => {
    const module = loadModule(
      moduleDir({ 'broken.tf.json': '{ not json', 'main.tf': 'terraform {\n  required_version = ">= 1.2"\n}\n' })
    )

    expect(getRequiredVersionExpression(module)).toBe('>= 1.2')
  })

  it('drops a JSON file whose structure is wrong rather than half-reading it', () => {
    // The backend here is perfectly readable, but the variable block is not.
    // Taking the backend anyway would fingerprint a plan against a file
    // Terraform itself would reject.
    const broken = JSON.stringify({
      terraform: { backend: { s3: { bucket: 'b' } } },
      variable: ['nonsense'],
    })
    const module = loadModule(moduleDir({ 'main.tf.json': broken }))

    expect(module.json).toHaveLength(0)
    expect(getBackendType(module)).toBe('local')
  })

  it('leaves json empty for a module with no JSON files', () => {
    const module = loadModule(moduleDir({ 'main.tf': 'terraform {}\n' }))

    expect(module.json).toEqual([])
  })
})

describe('HCL takes precedence, JSON fills the gaps', () => {
  it('prefers the HCL backend when both declare one', () => {
    const dir = moduleDir({
      'a.tf': 'terraform {\n  backend "local" {}\n}\n',
      'b.tf.json': JSON.stringify({ terraform: { backend: { s3: { bucket: 'b' } } } }),
    })

    expect(getBackendType(loadModule(dir))).toBe('local')
  })

  it('uses the JSON backend when no HCL file declares one', () => {
    const dir = moduleDir({
      'a.tf': 'variable "x" {}\n',
      'b.tf.json': JSON.stringify({ terraform: { backend: { s3: { bucket: 'b' } } } }),
    })

    expect(getBackendType(loadModule(dir))).toBe('s3')
  })

  it('prefers the HCL required_version when both declare one', () => {
    const dir = moduleDir({
      'a.tf': 'terraform {\n  required_version = ">= 1.2"\n}\n',
      'b.tf.json': JSON.stringify({ terraform: { required_version: '>= 9.9' } }),
    })

    expect(getRequiredVersionExpression(loadModule(dir))).toBe('>= 1.2')
  })

  it('combines sensitive variables from both syntaxes', () => {
    // Not a precedence question. These names decide what is masked in a
    // published comment, so missing either source leaks a value.
    const dir = moduleDir({
      'a.tf': 'variable "from_hcl" {\n  sensitive = true\n}\n',
      'b.tf.json': JSON.stringify({ variable: { from_json: { sensitive: true } } }),
    })

    expect(getSensitiveVariables(loadModule(dir)).sort()).toEqual(['from_hcl', 'from_json'])
  })

  it('does not report a name twice when both syntaxes declare it', () => {
    const dir = moduleDir({
      'a.tf': 'variable "shared" {\n  sensitive = true\n}\n',
      'b.tf.json': JSON.stringify({ variable: { shared: { sensitive: true } } }),
    })

    expect(getSensitiveVariables(loadModule(dir))).toEqual(['shared'])
  })
})

describe('the two syntaxes agree', () => {
  /**
   * The same configuration written both ways must produce the same answers.
   * This is the test that matters for migration: a module converted from HCL to
   * JSON must keep fingerprinting to the same backend, or every open plan
   * comment stops matching.
   */
  const hcl = loadModule(moduleDir({ 'main.tf': S3_HCL }))
  const json = loadModule(moduleDir({ 'main.tf.json': S3_JSON }))

  it('agree on the version constraint', () => {
    expect(getRequiredVersionExpression(json)).toBe(getRequiredVersionExpression(hcl))
  })

  it('agree on the backend type', () => {
    expect(getBackendType(json)).toBe(getBackendType(hcl))
  })

  it('agree on the backend config', () => {
    expect(readModuleBackendConfig(json)).toEqual(readModuleBackendConfig(hcl))
  })

  it('agree on the sensitive variables', () => {
    expect(getSensitiveVariables(json)).toEqual(getSensitiveVariables(hcl))
  })
})