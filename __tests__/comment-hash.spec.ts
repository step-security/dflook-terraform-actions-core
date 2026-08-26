import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  commentHash,
  normalisePlan,
  planHash,
  planOutHash,
  planTextMatches,
  removeUnchangedAttributes,
  removeWarnings,
} from '../src/comment/hash.js'

const PR = 'https://api.github.com/repos/o/r/issues/1'
const OTHER_PR = 'https://api.github.com/repos/o/r/issues/2'

/**
 * This decides whether an apply is authorised, so the tests are written around
 * the two ways it could fail dangerously: accepting a plan that differs, and
 * accepting a plan from somewhere else.
 */
describe('binding a plan to one pull request', () => {
  it('gives the same plan different hashes in different pull requests', () => {
    const plan = 'Plan: 1 to add, 0 to change, 0 to destroy.'
    expect(planHash(plan, PR)).not.toBe(planHash(plan, OTHER_PR))
  })

  it('is stable for the same plan and pull request', () => {
    const plan = 'Plan: 1 to add, 0 to change, 0 to destroy.'
    expect(planHash(plan, PR)).toBe(planHash(plan, PR))
  })

  it('changes when the plan changes', () => {
    expect(planHash('Plan: 1 to add', PR)).not.toBe(planHash('Plan: 2 to add', PR))
  })

  /**
   * A resource being destroyed rather than created must never hash the same.
   * This is the case that would matter most if normalisation were too broad.
   */
  it('distinguishes a create from a destroy', () => {
    const create = '  + resource "null_resource" "a" {}\nPlan: 1 to add, 0 to change, 0 to destroy.'
    const destroy = '  - resource "null_resource" "a" {}\nPlan: 0 to add, 0 to change, 1 to destroy.'
    expect(planHash(create, PR)).not.toBe(planHash(destroy, PR))
  })
})

describe('the namespace prefix', () => {
  /**
   * Pinned deliberately. It is a namespace rather than a secret, and a
   * repository migrating from upstream may have an open pull request whose plan
   * comment was written by upstream's action. Changing it would reject those
   * plans while reporting that the plan does not match.
   */
  it('matches upstream, so plans posted by upstream still apply', () => {
    expect(commentHash('x', 'salt')).toBe(
      require('crypto')
        .createHash('sha256')
        .update('dflook/terraform-github-actions/salt')
        .update('x')
        .digest('hex')
    )
  })
})

describe('removing unchanged attribute summaries', () => {
  it('drops the hidden attribute count', () => {
    const plan = '  ~ resource "a" "b" {\n      # (3 unchanged attributes hidden)\n    }'
    expect(removeUnchangedAttributes(plan)).not.toContain('unchanged attributes hidden')
  })

  /** The count varies between runs without the plan differing. */
  it('makes two plans with different counts hash the same', () => {
    const three = '  ~ resource "a" "b" {\n      # (3 unchanged attributes hidden)\n    }'
    const four = '  ~ resource "a" "b" {\n      # (4 unchanged attributes hidden)\n    }'
    expect(planHash(three, PR)).toBe(planHash(four, PR))
  })

  it('keeps an ordinary comment', () => {
    const plan = '  # aws_instance.web will be created'
    expect(removeUnchangedAttributes(plan)).toContain('will be created')
  })
})

describe('removing warnings after the summary', () => {
  it('drops a warning that follows the plan summary', () => {
    const plan = 'Plan: 1 to add, 0 to change, 0 to destroy.\nWarning: deprecated argument'
    expect(removeWarnings(plan)).not.toContain('Warning')
  })

  it('drops a diagnostic box after the summary', () => {
    const plan = 'Plan: 1 to add, 0 to change, 0 to destroy.\n╷\n│ Warning: something\n╵'
    expect(removeWarnings(plan)).not.toContain('Warning')
  })

  /**
   * Anything before the summary is part of what was reviewed, so removing it
   * would let the reviewed content change without changing the hash.
   */
  it('keeps a warning that comes before the plan', () => {
    const plan = 'Warning: this was reviewed\nPlan: 1 to add, 0 to change, 0 to destroy.'
    expect(removeWarnings(plan)).toContain('Warning: this was reviewed')
  })

  it('makes a provider deprecation notice not affect the hash', () => {
    const clean = 'Plan: 1 to add, 0 to change, 0 to destroy.'
    const noisy = 'Plan: 1 to add, 0 to change, 0 to destroy.\nWarning: deprecated\n│ detail'
    expect(planHash(clean, PR)).toBe(planHash(noisy, PR))
  })
})

describe('normalising', () => {
  it('is idempotent', () => {
    const plan = '  ~ a {\n      # (1 unchanged attributes hidden)\n    }\nPlan: 1 to add.\nWarning: x'
    const once = normalisePlan(plan)
    expect(normalisePlan(once)).toBe(once)
  })

  it('ignores surrounding blank space', () => {
    expect(planHash('\n\nPlan: 1 to add.\n\n', PR)).toBe(planHash('Plan: 1 to add.', PR))
  })
})

describe('hashing a saved plan file', () => {
  function planFile(contents: string): string {
    const path = join(mkdtempSync(join(tmpdir(), 'plan-')), 'plan.out')
    writeFileSync(path, contents)
    return path
  }

  it('is stable for the same file', () => {
    const path = planFile('binary plan contents')
    expect(planOutHash(path, PR)).toBe(planOutHash(path, PR))
  })

  /** A binary plan is the reviewed plan byte for byte, or it is not. */
  it('changes for a single byte difference', () => {
    expect(planOutHash(planFile('plan a'), PR)).not.toBe(planOutHash(planFile('plan b'), PR))
  })

  it('is bound to the pull request', () => {
    const path = planFile('same plan')
    expect(planOutHash(path, PR)).not.toBe(planOutHash(path, OTHER_PR))
  })
})

describe('comparing plans as text', () => {
  it('ignores surrounding blank space', () => {
    expect(planTextMatches('  plan\n', 'plan')).toBe(true)
  })

  it('rejects different plans', () => {
    expect(planTextMatches('plan a', 'plan b')).toBe(false)
  })
})

/**
 * The hashes below were produced by upstream's own Python implementation, not
 * written by hand. They are what makes migration work: a plan comment posted by
 * upstream's action must still be recognised as approving the same plan here.
 *
 * See fixtures/plan-hash-parity.json for how to regenerate them.
 */
describe('parity with upstream hashing', () => {
  const fixture = require('./fixtures/plan-hash-parity.json') as {
    salt: string
    cases: { name: string; plan: string; hash: string }[]
  }

  it('has cases to compare', () => {
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it.each(fixture.cases.map((c) => [c.name, c] as const))('matches on %s', (_name, testCase) => {
    expect(planHash(testCase.plan, fixture.salt)).toBe(testCase.hash)
  })
})
