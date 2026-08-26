import { compactPlan, savedPlanHasNoChanges } from '../src/terraform/apply.js'

describe('recognising a cloud plan with no changes', () => {
  /** Terraform Cloud refuses to apply an empty plan. Nothing is wrong. */
  it('spots the message', () => {
    expect(savedPlanHasNoChanges('Error: Saved plan has no changes')).toBe(true)
  })

  it('does not mistake a real failure for it', () => {
    expect(savedPlanHasNoChanges('Error: Insufficient permissions')).toBe(false)
  })
})

/**
 * The compacted plan is published as an artifact and compared against the plan
 * in a pull request comment, so it has to be identical between two runs of the
 * same plan. The lock messages appear only sometimes, which is exactly what
 * would break that.
 */
describe('compacting a plan', () => {
  it('drops the preamble before the plan', () => {
    const output = [
      'Acquiring state lock. This may take a few moments...',
      'random_id.x: Refreshing state...',
      'Terraform used the selected providers to generate the following execution plan.',
      '',
      'Terraform will perform the following actions:',
      '  + resource "null_resource" "a" {}',
      'Plan: 1 to add, 0 to change, 0 to destroy.',
    ].join('\n')

    const compacted = compactPlan(output)
    expect(compacted).not.toContain('Refreshing state')
    expect(compacted.startsWith('Terraform used the selected providers')).toBe(true)
  })

  it.each([
    'Releasing state lock. This may take a few moments...',
    'Acquiring state lock. This may take a few moments...',
  ])('removes %s from inside the plan', (noise) => {
    const output = ['Terraform will perform the following actions:', noise, 'Plan: 0 to add.'].join(
      '\n'
    )
    expect(compactPlan(output)).not.toContain('state lock')
  })

  it.each([
    ['no changes', 'No changes. Your infrastructure matches the configuration.'],
    ['an error', 'Error: Invalid configuration'],
    ['output-only changes', 'Changes to Outputs:'],
    ['OpenTofu wording', 'OpenTofu will perform the following actions:'],
    ['an older Terraform', 'An execution plan has been generated and is shown below'],
  ])('recognises %s as the start of the plan', (_label, first) => {
    const output = ['random_id.x: Refreshing state...', first, 'the rest'].join('\n')
    const compacted = compactPlan(output)
    expect(compacted.startsWith(first)).toBe(true)
  })

  /**
   * If the format is not recognised, returning nothing would silently discard
   * the plan. Returning it unchanged keeps it visible.
   */
  it('returns unrecognised output unchanged', () => {
    const output = 'something entirely unexpected\nand another line'
    expect(compactPlan(output)).toBe(output)
  })

  it('preserves a trailing newline', () => {
    expect(compactPlan('No changes.\n')).toBe('No changes.\n')
  })

  it('does not add a trailing newline', () => {
    expect(compactPlan('No changes.')).toBe('No changes.')
  })

  it('is stable when applied twice', () => {
    const output = 'Acquiring state lock. This may take a few moments...\nNo changes.\n'
    const once = compactPlan(output)
    expect(compactPlan(once)).toBe(once)
  })
})
