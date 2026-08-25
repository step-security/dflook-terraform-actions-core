import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  formatCloudTokens,
  formatHttpCredentials,
  renderNetrc,
  renderTerraformrc,
  writeCredentials,
} from '../src/setup/credentials.js'
import { TfVarsError, autoTfVarsName, writeAutoTfVars } from '../src/setup/tfvars.js'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'setup-'))
}

describe('Terraform Cloud tokens', () => {
  it('reads a hostname and token', () => {
    expect(formatCloudTokens('app.terraform.io=abc123')).toEqual([
      { host: 'app.terraform.io', token: 'abc123' },
    ])
  })

  it('reads several entries across lines', () => {
    expect(formatCloudTokens('a.example.com=one\nb.example.com=two')).toHaveLength(2)
  })

  /** Terraform Cloud tokens are base64-ish and routinely contain '='. */
  it('keeps a token containing equals signs intact', () => {
    expect(formatCloudTokens('app.terraform.io=abc==def=')[0].token).toBe('abc==def=')
  })

  it('rejects an entry with no separator', () => {
    expect(() => formatCloudTokens('app.terraform.io')).toThrow(/hostname.*token/)
  })

  it('renders a credentials block', () => {
    const rendered = renderTerraformrc([{ host: 'app.terraform.io', token: 'abc' }])
    expect(rendered).toBe('credentials "app.terraform.io" {\n  token = "abc"\n}\n')
  })
})

describe('HTTP credentials', () => {
  it('reads host, username and password', () => {
    expect(formatHttpCredentials('git.example.com=alice:secret')).toEqual([
      { host: 'git.example.com', username: 'alice', password: 'secret' },
    ])
  })

  /** Passwords and tokens frequently contain colons. */
  it('keeps a password containing colons intact', () => {
    expect(formatHttpCredentials('git.example.com=alice:a:b:c')[0].password).toBe('a:b:c')
  })

  it('accepts a path-qualified host', () => {
    const parsed = formatHttpCredentials('git.example.com/org/repo=alice:secret')
    expect(parsed[0].host).toBe('git.example.com/org/repo')
  })

  it('rejects a malformed entry', () => {
    expect(() => formatHttpCredentials('git.example.com=alice')).toThrow(/username.*password/)
  })

  /** netrc keys on host alone, so any path qualifier has to be dropped. */
  it('reduces a path-qualified host to its hostname in netrc', () => {
    const rendered = renderNetrc([
      { host: 'git.example.com/org/repo', username: 'alice', password: 'secret' },
    ])
    expect(rendered).toBe('machine git.example.com\nlogin alice\npassword secret\n')
  })
})

describe('writing credentials to disk', () => {
  it('writes .terraformrc with owner-only permissions', () => {
    const home = scratch()
    writeCredentials({ cloudTokens: 'app.terraform.io=abc' }, { home })

    const path = join(home, '.terraformrc')
    expect(readFileSync(path, 'utf8')).toContain('credentials "app.terraform.io"')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('writes .netrc with owner-only permissions', () => {
    const home = scratch()
    writeCredentials({ httpCredentials: 'git.example.com=alice:secret' }, { home })

    const path = join(home, '.netrc')
    expect(readFileSync(path, 'utf8')).toContain('machine git.example.com')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  /**
   * A workflow may have configured its own credentials before this runs.
   * Replacing the file would break module sources that already worked.
   */
  it('appends to an existing .netrc rather than replacing it', () => {
    const home = scratch()
    writeFileSync(join(home, '.netrc'), 'machine existing.example.com\nlogin bob\npassword old\n')

    writeCredentials({ httpCredentials: 'git.example.com=alice:secret' }, { home })

    const contents = readFileSync(join(home, '.netrc'), 'utf8')
    expect(contents).toContain('existing.example.com')
    expect(contents).toContain('git.example.com')
  })

  it('writes the SSH key with owner-only permissions', () => {
    const home = scratch()
    writeCredentials({ sshKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----' }, { home })

    const path = join(home, '.ssh', 'id_rsa')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, '.ssh')).mode & 0o777).toBe(0o700)
  })

  /** OpenSSH rejects a key file that does not end in a newline. */
  it('terminates the SSH key with a newline', () => {
    const home = scratch()
    writeCredentials({ sshKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----' }, { home })
    expect(readFileSync(join(home, '.ssh', 'id_rsa'), 'utf8').endsWith('\n')).toBe(true)
  })

  it('writes nothing when nothing was supplied', () => {
    const home = scratch()
    const result = writeCredentials({}, { home })
    expect(result).toEqual({ cloudHosts: [], netrcHosts: [], sshKeyWritten: false })
  })

  it('reports what it wrote', () => {
    const home = scratch()
    const result = writeCredentials(
      {
        cloudTokens: 'app.terraform.io=abc',
        httpCredentials: 'git.example.com/org=alice:secret',
        sshKey: 'key',
      },
      { home }
    )

    expect(result.cloudHosts).toEqual(['app.terraform.io'])
    expect(result.netrcHosts).toEqual(['git.example.com'])
    expect(result.sshKeyWritten).toBe(true)
  })
})

describe('auto tfvars naming', () => {
  /**
   * Terraform loads auto tfvars lexically and later files win, so the prefix is
   * what makes these override the configuration's own values.
   */
  it('prefixes with zzzz so the files load last', () => {
    expect(autoTfVarsName(0)).toMatch(/^zzzz-/)
  })

  it('numbers files so ordering between them is defined', () => {
    expect(autoTfVarsName(0, 'a.tfvars')).toContain('-00.')
    expect(autoTfVarsName(1, 'b.tfvars')).toContain('-01.')
    expect(autoTfVarsName(11, 'c.tfvars')).toContain('-11.')
  })

  /** JSON var files must keep JSON syntax, or Terraform parses them as HCL. */
  it('keeps the .json suffix for a JSON var file', () => {
    expect(autoTfVarsName(0, 'prod.json')).toBe(
      'zzzz-dflook-terraform-github-actions-00.prod.auto.tfvars.json'
    )
  })

  it('uses .auto.tfvars for an HCL var file', () => {
    expect(autoTfVarsName(0, 'prod.tfvars')).toBe(
      'zzzz-dflook-terraform-github-actions-00.prod.auto.tfvars'
    )
  })
})

describe('writing auto tfvars', () => {
  it('copies a var file into the module', () => {
    const workspace = scratch()
    const module = join(workspace, 'infra')
    mkdirSync(module)
    writeFileSync(join(workspace, 'prod.tfvars'), 'region = "eu-west-1"\n')

    const { created } = writeAutoTfVars({ varFile: 'prod.tfvars' }, module, workspace)

    expect(created).toHaveLength(1)
    expect(readFileSync(join(module, created[0]), 'utf8')).toContain('eu-west-1')
  })

  it('writes the variables input as a file', () => {
    const module = scratch()
    const { created } = writeAutoTfVars({ variables: 'region = "eu-west-1"' }, module, module)

    expect(readFileSync(join(module, created[0]), 'utf8')).toBe('region = "eu-west-1"\n')
  })

  /**
   * `variables` is documented to override `var_file`, which only holds if its
   * generated filename sorts after them.
   */
  it('orders the variables input after every var file', () => {
    const workspace = scratch()
    writeFileSync(join(workspace, 'a.tfvars'), 'x = 1\n')
    writeFileSync(join(workspace, 'b.tfvars'), 'x = 2\n')

    const { created } = writeAutoTfVars(
      { varFile: 'a.tfvars\nb.tfvars', variables: 'x = 3' },
      workspace,
      workspace
    )

    expect(created).toHaveLength(3)
    // Generated in lexical order, so Terraform's load order matches this list.
    expect([...created].sort()).toEqual(created)
    // The variables input is last, so its values win over both var files.
    expect(created[2]).toBe('zzzz-dflook-terraform-github-actions-02.auto.tfvars')
  })

  it('fails when a var file does not exist', () => {
    const module = scratch()
    expect(() => writeAutoTfVars({ varFile: 'absent.tfvars' }, module, module)).toThrow(TfVarsError)
  })

  it('creates nothing when neither input is given', () => {
    const module = scratch()
    expect(writeAutoTfVars({}, module, module).created).toEqual([])
  })
})
