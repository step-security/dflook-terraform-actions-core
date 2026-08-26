import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { InitError, backendConfigArgs } from '../src/terraform/init.js'
import { splitList } from '../src/terraform/exec.js'

let workspaceRoot: string
let modulePath: string

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'init-'))
  modulePath = join(workspaceRoot, 'infra')
  mkdirSync(modulePath)
})

describe('splitting list inputs', () => {
  it('splits on newlines', () => {
    expect(splitList('a\nb')).toEqual(['a', 'b'])
  })

  it('splits on commas', () => {
    expect(splitList('a,b')).toEqual(['a', 'b'])
  })

  /** A YAML block scalar almost always leaves a trailing newline. */
  it('drops empty entries', () => {
    expect(splitList('a\n\nb\n')).toEqual(['a', 'b'])
  })

  it('treats an unset input as empty', () => {
    expect(splitList(undefined)).toEqual([])
    expect(splitList('')).toEqual([])
    expect(splitList('   ')).toEqual([])
  })
})

describe('backend config values', () => {
  it('passes each value as its own argument', () => {
    const args = backendConfigArgs(
      { backendConfig: 'bucket=my-state\nkey=terraform.tfstate' },
      { modulePath, workspaceRoot }
    )
    expect(args).toEqual(['-backend-config=bucket=my-state', '-backend-config=key=terraform.tfstate'])
  })

  it('adds nothing when unset', () => {
    expect(backendConfigArgs({}, { modulePath, workspaceRoot })).toEqual([])
  })
})

describe('backend config files', () => {
  /**
   * Paths are given relative to the workspace, but init runs with the module as
   * its working directory, so they have to be rewritten.
   */
  it('rewrites a workspace-relative path to be module-relative', () => {
    writeFileSync(join(workspaceRoot, 'backend.tfvars'), '')
    const args = backendConfigArgs(
      { backendConfigFile: 'backend.tfvars' },
      { modulePath, workspaceRoot }
    )
    expect(args).toEqual(['-backend-config=../backend.tfvars'])
  })

  it('handles a file beside the module', () => {
    writeFileSync(join(modulePath, 'backend.tfvars'), '')
    const args = backendConfigArgs(
      { backendConfigFile: 'infra/backend.tfvars' },
      { modulePath, workspaceRoot }
    )
    expect(args).toEqual(['-backend-config=backend.tfvars'])
  })

  it('takes several files in order', () => {
    writeFileSync(join(workspaceRoot, 'a.tfvars'), '')
    writeFileSync(join(workspaceRoot, 'b.tfvars'), '')
    const args = backendConfigArgs(
      { backendConfigFile: 'a.tfvars\nb.tfvars' },
      { modulePath, workspaceRoot }
    )
    expect(args).toEqual(['-backend-config=../a.tfvars', '-backend-config=../b.tfvars'])
  })

  /**
   * Terraform would report this as a confusing backend error much later, so the
   * missing file is named up front.
   */
  it('fails when a file does not exist', () => {
    expect(() =>
      backendConfigArgs({ backendConfigFile: 'absent.tfvars' }, { modulePath, workspaceRoot })
    ).toThrow(InitError)
    expect(() =>
      backendConfigArgs({ backendConfigFile: 'absent.tfvars' }, { modulePath, workspaceRoot })
    ).toThrow(/Path does not exist: "absent.tfvars"/)
  })
})

describe('combining files and values', () => {
  /** Files first, then values, so a value can override what a file sets. */
  it('puts files before values', () => {
    writeFileSync(join(workspaceRoot, 'backend.tfvars'), '')
    const args = backendConfigArgs(
      { backendConfigFile: 'backend.tfvars', backendConfig: 'key=override' },
      { modulePath, workspaceRoot }
    )
    expect(args).toEqual(['-backend-config=../backend.tfvars', '-backend-config=key=override'])
  })
})
