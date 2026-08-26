import { getLockInfo, isStateLocked } from '../src/terraform/lock.js'

/** What Terraform actually prints when another run holds the lock. */
const LOCKED = `
Error: Error acquiring the state lock

Error message: ConditionalCheckFailedException: The conditional request failed
Lock Info:
  ID:        6a1c0d3e-1b2f-4a5c-9d8e-7f6a5b4c3d2e
  Path:      my-bucket/terraform.tfstate
  Operation: OperationTypeApply
  Who:       runner@fv-az123-456
  Version:   1.9.8
  Created:   2026-08-26 10:11:12.131415 +0000 UTC
  Info:

Terraform acquires a state lock to protect the state from being written
by multiple users at the same time.
`

describe('recognising a lock failure', () => {
  it('spots the error', () => {
    expect(isStateLocked(LOCKED)).toBe(true)
  })

  it('does not mistake another failure for a lock', () => {
    expect(isStateLocked('Error: Invalid provider configuration')).toBe(false)
  })

  it('treats empty output as not locked', () => {
    expect(isStateLocked('')).toBe(false)
  })
})

describe('reading who holds the lock', () => {
  it('extracts the fields', () => {
    const info = getLockInfo(LOCKED)

    expect(info).toMatchObject({
      ID: '6a1c0d3e-1b2f-4a5c-9d8e-7f6a5b4c3d2e',
      Path: 'my-bucket/terraform.tfstate',
      Operation: 'OperationTypeApply',
      Who: 'runner@fv-az123-456',
      Version: '1.9.8',
    })
  })

  it('keeps a value containing a colon intact', () => {
    const info = getLockInfo(LOCKED)
    expect(info?.Created).toBe('2026-08-26 10:11:12.131415 +0000 UTC')
  })

  it('returns undefined when the failure was not a lock', () => {
    expect(getLockInfo('Error: something else entirely')).toBeUndefined()
  })

  /**
   * An empty object and undefined mean different things: the lock did fail, but
   * Terraform said nothing about who holds it. Collapsing the two would report
   * the wrong failure reason.
   */
  it('distinguishes a lock with no details from no lock at all', () => {
    const info = getLockInfo('Error: Error acquiring the state lock\nno further detail')
    expect(info).toEqual({})
    expect(info).not.toBeUndefined()
  })

  it('ignores fields appearing before the lock error', () => {
    const output = `  ID:  not-part-of-the-lock\nError: Error acquiring the state lock\nLock Info:\n  ID:  real\n`
    expect(getLockInfo(output)).toEqual({ ID: 'real' })
  })
})
