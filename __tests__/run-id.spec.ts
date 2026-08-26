import { getRemoteRunId, isRemoteExecution } from '../src/terraform/run-id.js'

/** The shape Terraform actually prints for a remote operation. */
const REMOTE_OUTPUT = `
Running apply in Terraform Cloud. Output will stream here. Pressing Ctrl-C
will cancel the remote apply if it's still pending.

Preparing the remote apply...

To view this run in a browser, visit:
https://app.terraform.io/app/acme/production/runs/run-CZcmD7eagxc4Xj2K

Waiting for the plan to start...
`

describe('finding the run id', () => {
  it('reads it from the run link', () => {
    expect(getRemoteRunId(REMOTE_OUTPUT)).toBe('run-CZcmD7eagxc4Xj2K')
  })

  it('returns nothing when there is no link', () => {
    expect(getRemoteRunId('Apply complete! Resources: 1 added.')).toBeUndefined()
  })

  it('handles empty output', () => {
    expect(getRemoteRunId('')).toBeUndefined()
    expect(getRemoteRunId(undefined)).toBeUndefined()
  })

  it('works with a self-hosted hostname', () => {
    expect(
      getRemoteRunId('https://tfe.example.com/app/acme/prod/runs/run-abc123XYZ')
    ).toBe('run-abc123XYZ')
  })

  /**
   * Terraform prints the link to stderr when the operation failed, which is
   * exactly when a workflow most wants the id.
   */
  it('falls back to a later source', () => {
    expect(getRemoteRunId('nothing here', REMOTE_OUTPUT)).toBe('run-CZcmD7eagxc4Xj2K')
  })

  it('prefers the earlier source', () => {
    const first = 'https://app.terraform.io/app/a/b/runs/run-first'
    const second = 'https://app.terraform.io/app/a/b/runs/run-second'
    expect(getRemoteRunId(first, second)).toBe('run-first')
  })

  it('takes the first link when output has several', () => {
    const output = [
      'https://app.terraform.io/app/a/b/runs/run-one',
      'https://app.terraform.io/app/a/b/runs/run-two',
    ].join('\n')
    expect(getRemoteRunId(output)).toBe('run-one')
  })

  it('ignores a url that is not a run link', () => {
    expect(
      getRemoteRunId('See https://developer.hashicorp.com/terraform/docs for details')
    ).toBeUndefined()
  })

  it('tolerates a trailing carriage return', () => {
    expect(getRemoteRunId('https://app.terraform.io/app/a/b/runs/run-xyz\r')).toBe('run-xyz')
  })
})

/**
 * Applied per line rather than across the whole document, so cost depends on
 * line length rather than output size.
 */
describe('scanning cost', () => {
  it('handles a large output promptly', () => {
    const noise = 'Still applying... [10s elapsed]\n'.repeat(20_000)
    const started = Date.now()
    expect(getRemoteRunId(noise)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('handles a long line that nearly matches promptly', () => {
    const line = `https://${'a/'.repeat(30_000)}/runs/nope`
    const started = Date.now()
    getRemoteRunId(line)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('which backends run remotely', () => {
  it.each(['remote', 'cloud'])('includes %s', (backend) => {
    expect(isRemoteExecution(backend)).toBe(true)
  })

  it.each(['s3', 'local', 'gcs', '', undefined])('excludes %s', (backend) => {
    expect(isRemoteExecution(backend)).toBe(false)
  })
})
