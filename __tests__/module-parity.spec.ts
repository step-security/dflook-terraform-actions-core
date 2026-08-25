import { readFileSync } from 'fs'
import { join } from 'path'
import {
  getBackendType,
  getRequiredVersionExpression,
  getSensitiveVariables,
  loadModule,
} from '../src/terraform/module.js'


/**
 * Differential test of the module reader against a real HCL parser.
 *
 * The expectations were produced by running `python-hcl2` — the parser upstream
 * uses — over the Terraform fixtures in dflook/terraform-github-actions, then
 * extracting the same four facts we do. The fixtures are copied in so the test
 * needs no network and no Python.
 *
 * This is the check that matters for the reader: it reads specific constructs
 * rather than parsing HCL properly, so the question is not "is the code right"
 * but "does it agree with a real parser on real configurations".
 */
interface Expectation {
  module: string
  requiredVersion: string | null
  backend: string
  sensitive: string[]
}

// Read as data rather than imported as a module; see upstream-parity.spec.ts.
const cases = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'module-expectations.json'), 'utf8')
) as Expectation[]
const fixtureRoot = join(__dirname, 'fixtures', 'modules')

describe('module reader agrees with python-hcl2', () => {
  it('has a meaningful corpus', () => {
    expect(cases.length).toBeGreaterThan(90)
  })

  it.each(cases.map((c) => [c.module, c] as const))('%s', (_name, expected) => {
    const module = loadModule(join(fixtureRoot, expected.module))

    expect(getRequiredVersionExpression(module) ?? null).toBe(expected.requiredVersion)
    expect(getBackendType(module)).toBe(expected.backend)
    expect(getSensitiveVariables(module).sort()).toEqual(expected.sensitive)
  })
})

describe('comment handling', () => {
  /**
   * A commented-out backend is common while migrating state. Matching it would
   * select the wrong backend, which changes version discovery and, for the
   * deploy actions, where state is read from.
   */
  it('ignores a backend inside a line comment', () => {
    const module = { body: '', files: [] }
    const withComment = {
      ...module,
      body: require('../src/terraform/module').stripComments(
        'terraform {\n  # backend "s3" {}\n  backend "local" {}\n}\n'
      ),
    }
    expect(getBackendType(withComment)).toBe('local')
  })

  it('ignores a backend inside a block comment', () => {
    const { stripComments } = require('../src/terraform/module')
    const body = stripComments('terraform {\n/* backend "s3" {} */\n  backend "local" {}\n}\n')
    expect(getBackendType({ body, files: [] })).toBe('local')
  })

  it('does not treat a # inside a string as a comment', () => {
    const { stripComments } = require('../src/terraform/module')
    const body = stripComments('variable "a" {\n  default = "value # not a comment"\n}\n')
    expect(body).toContain('# not a comment')
  })

  it('leaves heredoc bodies intact', () => {
    const { stripComments } = require('../src/terraform/module')
    const body = stripComments('locals {\n  script = <<-EOT\n    # keep me\n  EOT\n}\n')
    expect(body).toContain('# keep me')
  })
})
