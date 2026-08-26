import {
  collapseThreshold,
  formatHeaders,
  matchingHeaders,
  parseComment,
  parseHeaders,
  renderComment,
} from '../src/comment/comment.js'

const PLAN = 'Terraform will perform the following actions:\n\nPlan: 1 to add, 0 to change, 0 to destroy.'

function comment(overrides: Partial<Parameters<typeof renderComment>[0]> = {}) {
  return {
    headers: { workspace: 'default' },
    description: 'Terraform plan in `infra`',
    summary: 'Plan: 1 to add, 0 to change, 0 to destroy.',
    bodyHighlighting: 'hcl',
    body: PLAN,
    status: '',
    ...overrides,
  }
}

/**
 * Rendering and parsing have to be exact inverses. The apply reads the plan back
 * out of a comment to decide whether it was approved, so a round-trip that loses
 * or adds anything would change the plan text and reject a plan that was in fact
 * approved.
 */
describe('round-tripping a comment', () => {
  it('recovers every field', () => {
    const original = comment()
    const parsed = parseComment(renderComment(original))

    expect(parsed).toEqual(original)
  })

  it('recovers the plan text unchanged', () => {
    const parsed = parseComment(renderComment(comment()))
    expect(parsed?.body).toBe(PLAN)
  })

  it('round-trips a status', () => {
    const parsed = parseComment(renderComment(comment({ status: 'Applied by @someone' })))
    expect(parsed?.status).toBe('Applied by @someone')
  })

  it('round-trips a plan containing a fence-like line', () => {
    const body = 'Plan: 1 to add\n  + description = "see ``` for details"'
    const parsed = parseComment(renderComment(comment({ body })))
    expect(parsed?.body).toBe(body)
  })

  it('round-trips an empty status', () => {
    const parsed = parseComment(renderComment(comment({ status: '' })))
    expect(parsed?.status).toBe('')
  })

  it('survives two round-trips unchanged', () => {
    const once = renderComment(comment())
    const twice = renderComment(parseComment(once)!)
    expect(twice).toBe(once)
  })
})

describe('the hidden header', () => {
  it('uses compact json so it matches upstream', () => {
    expect(formatHeaders({ workspace: 'default', label: 'prod' })).toBe(
      '<!-- dflook/terraform-github-actions {"workspace":"default","label":"prod"} -->'
    )
  })

  it('reads back what it wrote', () => {
    const headers = { workspace: 'staging', plan_hash: 'abc123' }
    expect(parseHeaders(formatHeaders(headers))).toEqual(headers)
  })

  it('reads a header written by upstream', () => {
    expect(
      parseHeaders('<!-- dflook/terraform-github-actions {"workspace":"default"} -->')
    ).toEqual({ workspace: 'default' })
  })

  /**
   * Some earlier versions wrote literal nulls, which made a comment
   * unmatchable. A null was never meaningful.
   */
  it('drops null values', () => {
    expect(
      parseHeaders('<!-- dflook/terraform-github-actions {"workspace":"default","label":null} -->')
    ).toEqual({ workspace: 'default' })
  })

  it('treats a malformed header as no header', () => {
    expect(parseHeaders('<!-- dflook/terraform-github-actions {not json} -->')).toEqual({})
  })

  it('ignores an unrelated html comment', () => {
    expect(parseHeaders('<!-- something else -->')).toEqual({})
  })

  it('treats a missing header as no header', () => {
    expect(parseHeaders(undefined)).toEqual({})
  })
})

describe('recognising our comments', () => {
  it('ignores a comment that is not ours', () => {
    expect(parseComment('Just a normal review comment')).toBeUndefined()
  })

  it('parses a comment with no header', () => {
    const body = 'A plan\n<details>\n<summary>sum</summary>\n\n```hcl\nPlan: 1 to add\n```\n</details>'
    expect(parseComment(body)?.body).toBe('Plan: 1 to add')
  })

  it('parses one written with the details expanded', () => {
    const body = 'A plan\n<details open>\n<summary>sum</summary>\n\n```\nPlan: 1 to add\n```\n</details>'
    expect(parseComment(body)?.body).toBe('Plan: 1 to add')
  })

  it('parses one with no summary', () => {
    const body = 'A plan\n<details>\n\n```\nPlan: 1 to add\n```\n</details>'
    expect(parseComment(body)?.summary).toBe('')
  })
})

/**
 * An error must never be hidden behind a click, and a five line plan gains
 * nothing from being collapsed.
 */
describe('whether the plan is shown expanded', () => {
  it('expands an error', () => {
    expect(renderComment(comment({ body: 'Error: invalid provider' }))).toContain('<details open>')
  })

  it('expands a short plan', () => {
    expect(renderComment(comment({ body: 'Plan: 1 to add' }))).toContain('<details open>')
  })

  it('collapses a long plan', () => {
    const long = ['Plan: 1 to add', ...Array.from({ length: 40 }, (_, i) => `line ${i}`)].join('\n')
    expect(renderComment(comment({ body: long }))).toContain('<details>')
  })

  it('expands when there is no summary to click', () => {
    const long = ['Plan: 1 to add', ...Array.from({ length: 40 }, (_, i) => `line ${i}`)].join('\n')
    expect(renderComment(comment({ body: long, summary: '' }))).toContain('<details open>')
  })

  it('respects a configured threshold', () => {
    const body = ['Plan: 1 to add', 'a', 'b'].join('\n')
    expect(renderComment(comment({ body }), { collapseThreshold: 2 })).toContain('<details>')
  })
})

describe('the configured threshold', () => {
  it('defaults to 10', () => {
    expect(collapseThreshold({} as NodeJS.ProcessEnv)).toBe(10)
  })

  it('reads the environment', () => {
    expect(collapseThreshold({ TF_PLAN_COLLAPSE_LENGTH: '30' } as NodeJS.ProcessEnv)).toBe(30)
  })

  it('ignores a non-numeric value', () => {
    expect(collapseThreshold({ TF_PLAN_COLLAPSE_LENGTH: 'lots' } as NodeJS.ProcessEnv)).toBe(10)
  })
})

/**
 * A pull request touching several modules gets several comments, and the headers
 * are the only thing telling them apart. Matching the wrong one would approve a
 * plan from a different module.
 */
describe('matching a comment to a configuration', () => {
  const parsed = parseComment(
    renderComment(comment({ headers: { workspace: 'staging', label: 'prod' } }))
  )!

  it('matches when every required header agrees', () => {
    expect(matchingHeaders(parsed, { workspace: 'staging', label: 'prod' })).toBe(true)
  })

  it('rejects a different workspace', () => {
    expect(matchingHeaders(parsed, { workspace: 'default' })).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(matchingHeaders(parsed, { backend_type: 's3' })).toBe(false)
  })

  /** Extra headers are ignored, so a newer version adding one still matches. */
  it('ignores headers it was not asked about', () => {
    expect(matchingHeaders(parsed, { workspace: 'staging' })).toBe(true)
  })

  /** undefined means the header must be absent, which is how closed is detected. */
  it('requires an absent header when asked for undefined', () => {
    expect(matchingHeaders(parsed, { workspace: 'staging', closed: undefined })).toBe(true)
  })

  it('rejects when a header that must be absent is present', () => {
    expect(matchingHeaders(parsed, { label: undefined })).toBe(false)
  })
})
