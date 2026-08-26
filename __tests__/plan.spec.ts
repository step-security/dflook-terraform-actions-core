import {
  PLAN_CHANGES,
  PLAN_ERROR,
  PLAN_NO_CHANGES,
  PlanArgsError,
  cannotSavePlan,
  planArgs,
} from '../src/terraform/plan.js'

describe('the exit codes', () => {
  /**
   * These are Terraform's, not ours. Confusing 1 with 2 would report a broken
   * configuration as "there are changes to apply", which reads as normal.
   */
  it('keep error and changes distinct', () => {
    expect(PLAN_NO_CHANGES).toBe(0)
    expect(PLAN_ERROR).toBe(1)
    expect(PLAN_CHANGES).toBe(2)
  })
})

describe('parallelism', () => {
  it('is left to Terraform when zero', () => {
    expect(planArgs({ parallelism: '0' }).parallelism).toEqual([])
  })

  it('is omitted when not given', () => {
    expect(planArgs({}).parallelism).toEqual([])
  })

  it('is passed through when set', () => {
    expect(planArgs({ parallelism: '5' }).parallelism).toEqual(['-parallelism=5'])
  })

  it('ignores a non-numeric value rather than passing it on', () => {
    expect(planArgs({ parallelism: 'lots' }).parallelism).toEqual([])
  })
})

describe('resource address arguments', () => {
  it('adds one target', () => {
    expect(planArgs({ target: 'aws_instance.web' }).args).toEqual(['-target', 'aws_instance.web'])
  })

  it('adds each target on its own line', () => {
    expect(planArgs({ target: 'aws_instance.web\naws_instance.db' }).args).toEqual([
      '-target',
      'aws_instance.web',
      '-target',
      'aws_instance.db',
    ])
  })

  it('accepts a comma-separated list', () => {
    expect(planArgs({ replace: 'a.b,c.d' }).args).toEqual(['-replace', 'a.b', '-replace', 'c.d'])
  })

  it('ignores blank entries from a trailing newline', () => {
    expect(planArgs({ target: 'aws_instance.web\n\n' }).args).toEqual([
      '-target',
      'aws_instance.web',
    ])
  })

  /**
   * Terraform rejects these together too, but only after initializing, so the
   * message is buried. Failing up front is the difference between a clear error
   * and a confusing one.
   */
  it('refuses target and exclude together', () => {
    expect(() => planArgs({ target: 'a.b', exclude: 'c.d' })).toThrow(PlanArgsError)
  })

  it('allows exclude on its own', () => {
    expect(planArgs({ exclude: 'c.d' }).args).toEqual(['-exclude', 'c.d'])
  })

  it('does not treat a blank target as a conflict', () => {
    expect(() => planArgs({ target: '   ', exclude: 'c.d' })).not.toThrow()
  })
})

describe('boolean flags', () => {
  it('adds -destroy when planning a destroy', () => {
    expect(planArgs({ destroy: true }).args).toContain('-destroy')
  })

  it('adds nothing when not destroying', () => {
    expect(planArgs({ destroy: false }).args).not.toContain('-destroy')
  })

  /** Only an explicit false disables refresh; unset means Terraform's default. */
  it('disables refresh only when explicitly false', () => {
    expect(planArgs({ refresh: false }).args).toContain('-refresh=false')
    expect(planArgs({}).args).not.toContain('-refresh=false')
    expect(planArgs({ refresh: true }).args).not.toContain('-refresh=false')
  })
})

describe('recognising a backend that cannot save a plan', () => {
  it('spots the remote backend message', () => {
    expect(cannotSavePlan('Error: Saving a generated plan is currently not supported')).toBe(true)
  })

  it('does not mistake an ordinary failure for it', () => {
    expect(cannotSavePlan('Error: Invalid provider configuration')).toBe(false)
  })

  it('handles empty output', () => {
    expect(cannotSavePlan('')).toBe(false)
  })
})
