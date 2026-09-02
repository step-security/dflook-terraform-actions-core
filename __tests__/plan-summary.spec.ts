import { planCounts, planSummaryLine } from '../src/terraform/plan-summary.js'

describe('counting operations', () => {
  it('reads the summary line', () => {
    expect(planCounts('Plan: 1 to add, 2 to change, 3 to destroy.')).toEqual({
      add: 1,
      change: 2,
      destroy: 3,
      move: 0,
      import: 0,
    })
  })

  it('reads imports', () => {
    expect(planCounts('Plan: 2 to import, 1 to add, 0 to change, 0 to destroy.').import).toBe(2)
  })

  it('reports zeroes when there is no summary line', () => {
    expect(planCounts('No changes. Your infrastructure matches the configuration.')).toEqual({
      add: 0,
      change: 0,
      destroy: 0,
      move: 0,
      import: 0,
    })
  })

  it('ignores an operation it does not know', () => {
    expect(() => planCounts('Plan: 1 to teleport, 2 to add.')).not.toThrow()
    expect(planCounts('Plan: 1 to teleport, 2 to add.').add).toBe(2)
  })
})

/**
 * Terraform includes moves in the summary line only in some versions. Reporting
 * zero moves for a plan that moves things would be a silently wrong output, so
 * the individual lines are counted when the summary is silent.
 */
describe('counting moves', () => {
  const moves = [
    '  # module.a.thing has moved to module.b.thing',
    '  # aws_instance.old has moved to aws_instance.new',
  ].join('\n')

  it('counts the moved lines when the summary omits them', () => {
    const plan = `${moves}\nPlan: 0 to add, 0 to change, 0 to destroy.`
    expect(planCounts(plan).move).toBe(2)
  })

  it('prefers the summary when it mentions moves', () => {
    const plan = `${moves}\nPlan: 0 to add, 0 to change, 0 to destroy, 5 to move.`
    expect(planCounts(plan).move).toBe(5)
  })

  /** The pattern is anchored, so prose mentioning a move must not count. */
  it('does not count a line that merely talks about moving', () => {
    const plan = 'Note: you could have moved this to somewhere else\nPlan: 1 to add.'
    expect(planCounts(plan).move).toBe(0)
  })
})

describe('the collapsed summary line', () => {
  it('uses the plan summary', () => {
    expect(planSummaryLine('Plan: 1 to add, 0 to change, 0 to destroy.')).toBe(
      'Plan: 1 to add, 0 to change, 0 to destroy.'
    )
  })

  /** Has to be readable without expanding the comment. */
  it('reports no changes', () => {
    expect(planSummaryLine('No changes. Your infrastructure matches the configuration.')).toBe(
      'No changes. Your infrastructure matches the configuration.'
    )
  })

  it('reports an error', () => {
    expect(planSummaryLine('Error: Invalid provider configuration')).toBe(
      'Error: Invalid provider configuration'
    )
  })

  it('returns the error even when a plan line follows', () => {
    expect(planSummaryLine('Error: broken\nPlan: 1 to add.')).toBe('Error: broken')
  })

  it('appends counted moves the summary omitted', () => {
    const plan = '  # a.b has moved to c.d\nPlan: 1 to add, 0 to change, 0 to destroy.'
    expect(planSummaryLine(plan)).toBe('Plan: 1 to add, 0 to change, 0 to destroy, 1 to move.')
  })

  it('leaves the summary alone when it already mentions moves', () => {
    const plan = '  # a.b has moved to c.d\nPlan: 0 to add, 2 to move.'
    expect(planSummaryLine(plan)).toBe('Plan: 0 to add, 2 to move.')
  })

  /** An output-only change produces no `Plan:` line at all. */
  it('reports output-only changes', () => {
    expect(planSummaryLine('Changes to Outputs:\n  + url = "example.com"')).toBe(
      'Changes to Outputs.'
    )
  })

  it('combines a plan summary with output changes', () => {
    const plan = 'Plan: 1 to add, 0 to change, 0 to destroy.\nChanges to Outputs:'
    expect(planSummaryLine(plan)).toBe(
      'Plan: 1 to add, 0 to change, 0 to destroy. Changes to Outputs.'
    )
  })

  /** Terraform 1.4.0 stopped printing the summary in some cases. */
  describe('when there is no summary at all', () => {
    it('says a plan was generated when there are changes', () => {
      expect(planSummaryLine('some unrecognised output', true)).toBe('Plan generated.')
    })

    it('says no changes when there are none', () => {
      expect(planSummaryLine('some unrecognised output', false)).toBe('No changes.')
    })

    it('assumes changes by default', () => {
      expect(planSummaryLine('some unrecognised output')).toBe('Plan generated.')
    })
  })
})
describe('parsing cost', () => {
  it('handles a long run of digits promptly', () => {
    const started = Date.now()
    planCounts(`Plan: ${'9'.repeat(80_000)}`)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('still reads realistic counts', () => {
    expect(planCounts('Plan: 12 to add, 345 to change, 6789 to destroy.')).toMatchObject({
      add: 12,
      change: 345,
      destroy: 6789,
    })
  })
})
