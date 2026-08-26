import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  completeBackendConfig,
  readBackendConfigInput,
  readModuleBackendConfig,
} from '../src/comment/backend-config.js'
import { loadModule } from '../src/terraform/module.js'

function moduleWith(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'backend-module-'))
  writeFileSync(join(dir, 'main.tf'), source)
  return { module: loadModule(dir), dir }
}

describe('reading the backend block', () => {
  it('reads simple values', () => {
    const { module } = moduleWith(`
terraform {
  backend "s3" {
    bucket = "my-state"
    key    = "terraform.tfstate"
  }
}
`)
    expect(readModuleBackendConfig(module)).toEqual({
      bucket: 'my-state',
      key: 'terraform.tfstate',
    })
  })

  it('reads an unquoted backend label', () => {
    const { module } = moduleWith('terraform {\n  backend s3 {\n    bucket = "b"\n  }\n}\n')
    expect(readModuleBackendConfig(module)).toEqual({ bucket: 'b' })
  })

  it('reads a cloud block', () => {
    const { module } = moduleWith(`
terraform {
  cloud {
    organization = "acme"
  }
}
`)
    expect(readModuleBackendConfig(module)).toEqual({ organization: 'acme' })
  })

  /**
   * A nested block would otherwise cut the body short at its closing brace, so
   * anything after it would be missed.
   */
  it('does not stop at a nested block', () => {
    const { module } = moduleWith(`
terraform {
  backend "remote" {
    organization = "acme"
    workspaces {
      name = "prod"
    }
    hostname = "app.terraform.io"
  }
}
`)
    const config = readModuleBackendConfig(module)
    expect(config.organization).toBe('acme')
    expect(config.hostname).toBe('app.terraform.io')
    expect(config.workspaces).toContain('name = "prod"')
  })

  /**
   * A commented-out backend block is very common while migrating state.
   * Reading it would fingerprint a backend that is not in use.
   */
  it('ignores a commented-out backend', () => {
    const { module } = moduleWith(`
terraform {
  # backend "s3" {
  #   bucket = "old-bucket"
  # }
  backend "gcs" {
    bucket = "new-bucket"
  }
}
`)
    expect(readModuleBackendConfig(module)).toEqual({ bucket: 'new-bucket' })
  })

  it('returns nothing when there is no backend', () => {
    const { module } = moduleWith('resource "null_resource" "a" {}\n')
    expect(readModuleBackendConfig(module)).toEqual({})
  })
})

describe('reading the backend_config input', () => {
  it('reads key=value pairs', () => {
    expect(readBackendConfigInput('bucket=my-state\nkey=terraform.tfstate')).toEqual({
      bucket: 'my-state',
      key: 'terraform.tfstate',
    })
  })

  /** A value may well contain an equals sign, so only the first separates. */
  it('splits on the first equals only', () => {
    expect(readBackendConfigInput('conn_str=postgres://u:p@h/db?a=b')).toEqual({
      conn_str: 'postgres://u:p@h/db?a=b',
    })
  })

  it('ignores an entry with no equals', () => {
    expect(readBackendConfigInput('nonsense')).toEqual({})
  })

  it('handles an unset input', () => {
    expect(readBackendConfigInput(undefined)).toEqual({})
  })
})

describe('assembling the complete config', () => {
  it('lets a config file override the module block', () => {
    const { module, dir } = moduleWith(
      'terraform {\n  backend "s3" {\n    bucket = "from-module"\n  }\n}\n'
    )
    writeFileSync(join(dir, 'backend.tfvars'), 'bucket = "from-file"\n')

    const config = completeBackendConfig({
      module,
      backendConfigFile: 'backend.tfvars',
      workspaceRoot: dir,
    })
    expect(config.bucket).toBe('from-file')
  })

  it('lets the input override a config file', () => {
    const { module, dir } = moduleWith(
      'terraform {\n  backend "s3" {\n    bucket = "from-module"\n  }\n}\n'
    )
    writeFileSync(join(dir, 'backend.tfvars'), 'bucket = "from-file"\n')

    const config = completeBackendConfig({
      module,
      backendConfigFile: 'backend.tfvars',
      backendConfig: 'bucket=from-input',
      workspaceRoot: dir,
    })
    expect(config.bucket).toBe('from-input')
  })

  it('keeps values that only one layer sets', () => {
    const { module, dir } = moduleWith(
      'terraform {\n  backend "s3" {\n    bucket = "b"\n  }\n}\n'
    )
    const config = completeBackendConfig({
      module,
      backendConfig: 'key=terraform.tfstate',
      workspaceRoot: dir,
    })
    expect(config).toEqual({ bucket: 'b', key: 'terraform.tfstate' })
  })

  /**
   * Kept rather than filtered. The pg backend is identified by its conn_str,
   * which carries a password, and dropping it would stop comments matching for
   * those users. Only a hash of this ever reaches a comment.
   */
  it('keeps a credential-bearing value that identifies the backend', () => {
    const { module, dir } = moduleWith(
      'terraform {\n  backend "pg" {\n    conn_str = "postgres://u:secret@h/db"\n  }\n}\n'
    )
    expect(completeBackendConfig({ module, workspaceRoot: dir }).conn_str).toBe(
      'postgres://u:secret@h/db'
    )
  })

  it('ignores a config file that does not exist', () => {
    const { module, dir } = moduleWith('terraform {\n  backend "s3" {\n    bucket = "b"\n  }\n}\n')
    expect(() =>
      completeBackendConfig({ module, backendConfigFile: 'absent.tfvars', workspaceRoot: dir })
    ).not.toThrow()
  })
})
