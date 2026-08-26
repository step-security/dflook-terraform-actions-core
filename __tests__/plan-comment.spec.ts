import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseComment, renderComment } from '../src/comment/comment.js'
import { GitHubClient } from '../src/comment/github.js'
import { planHash, planOutHash } from '../src/comment/hash.js'
import {
  findPlanComment,
  isApproved,
  isBinaryPlanApproved,
  planCommentHeaders,
  planModifierHash,
} from '../src/comment/plan-comment.js'

const ISSUE = 'https://api.github.com/repos/o/r/issues/1'
const PLAN = 'Plan: 1 to add, 0 to change, 0 to destroy.'

function commentBody(overrides: Record<string, unknown> = {}, body = PLAN): string {
  return renderComment({
    headers: { workspace: 'default', ...(overrides as Record<string, string>) },
    description: 'Plan',
    summary: 'Plan: 1 to add',
    bodyHighlighting: 'hcl',
    body,
    status: '',
  })
}

function clientWith(comments: unknown[], login = 'me'): GitHubClient {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes('graphql')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data: { viewer: { login } } }),
      }
    }
    return { ok: true, status: 200, headers: new Headers(), json: async () => comments }
  }) as unknown as typeof fetch

  return new GitHubClient({ token: 't', fetchImpl })
}

describe('identifying which configuration a comment belongs to', () => {
  const identity = { workspace: 'default', backendFingerprint: '{"bucket":"b"}' }

  it('requires the closed header to be absent', () => {
    expect(planCommentHeaders(identity, ISSUE).closed).toBeUndefined()
  })

  it('binds the backend fingerprint to the pull request', () => {
    const here = planCommentHeaders(identity, ISSUE).backend
    const elsewhere = planCommentHeaders(identity, `${ISSUE}0`).backend
    expect(here).not.toBe(elsewhere)
  })

  it('distinguishes two backends', () => {
    const a = planCommentHeaders({ ...identity, backendFingerprint: '{"bucket":"a"}' }, ISSUE)
    const b = planCommentHeaders({ ...identity, backendFingerprint: '{"bucket":"b"}' }, ISSUE)
    expect(a.backend).not.toBe(b.backend)
  })

  it('omits an unset label', () => {
    expect(planCommentHeaders(identity, ISSUE).label).toBeUndefined()
  })

  it('records a label when set', () => {
    expect(planCommentHeaders({ ...identity, label: 'prod' }, ISSUE).label).toBe('prod')
  })

  /** They are the same state, so a configuration moving between the two spellings keeps its comment. */
  it('records cloud as remote', () => {
    expect(planCommentHeaders({ ...identity, backendType: 'cloud' }, ISSUE).backend_type).toBe(
      'remote'
    )
  })

  it('records other backend types as given', () => {
    expect(planCommentHeaders({ ...identity, backendType: 's3' }, ISSUE).backend_type).toBe('s3')
  })
})

/**
 * A plan restricted with -target is not the same plan as an unrestricted one, so
 * it must not match the same comment.
 */
describe('hashing the plan arguments', () => {
  it('is absent when nothing restricts the plan', () => {
    expect(planModifierHash({})).toBeUndefined()
  })

  it('distinguishes a targeted plan from an unrestricted one', () => {
    expect(planModifierHash({ target: 'aws_instance.web' })).toBeDefined()
  })

  it('distinguishes two different targets', () => {
    expect(planModifierHash({ target: 'a.b' })).not.toBe(planModifierHash({ target: 'c.d' }))
  })

  /** The order targets were listed in does not change the plan. */
  it('ignores the order targets were given in', () => {
    expect(planModifierHash({ target: 'a.b\nc.d' })).toBe(planModifierHash({ target: 'c.d\na.b' }))
  })

  it('treats a comma separated list the same as newlines', () => {
    expect(planModifierHash({ target: 'a.b,c.d' })).toBe(planModifierHash({ target: 'a.b\nc.d' }))
  })

  it('distinguishes a destroy plan', () => {
    expect(planModifierHash({ destroy: true })).toBeDefined()
    expect(planModifierHash({ destroy: true })).not.toBe(planModifierHash({ target: 'a.b' }))
  })

  it('distinguishes target from exclude', () => {
    expect(planModifierHash({ target: 'a.b' })).not.toBe(planModifierHash({ exclude: 'a.b' }))
  })
})

/**
 * This is the authorisation decision. The dangerous failure is accepting a plan
 * that differs from the one reviewed.
 */
describe('deciding whether a plan was approved', () => {
  it('approves a plan matching the recorded hash', () => {
    const body = commentBody({ plan_hash: planHash(PLAN, ISSUE) })
    expect(isApproved(PLAN, parseComment(body)!, ISSUE)).toBe(true)
  })

  it('rejects a plan that differs from the recorded hash', () => {
    const body = commentBody({ plan_hash: planHash(PLAN, ISSUE) })
    expect(isApproved('Plan: 5 to destroy.', parseComment(body)!, ISSUE)).toBe(false)
  })

  /** A hash from another pull request must not authorise this one. */
  it('rejects a hash recorded against a different pull request', () => {
    const body = commentBody({ plan_hash: planHash(PLAN, 'https://api.github.com/repos/o/r/issues/2') })
    expect(isApproved(PLAN, parseComment(body)!, ISSUE)).toBe(false)
  })

  it('falls back to comparing text when no hash was recorded', () => {
    const body = commentBody({}, PLAN)
    expect(isApproved(PLAN, parseComment(body)!, ISSUE)).toBe(true)
  })

  it('rejects differing text when no hash was recorded', () => {
    const body = commentBody({}, PLAN)
    expect(isApproved('Plan: 9 to add.', parseComment(body)!, ISSUE)).toBe(false)
  })
})

describe('deciding whether a saved plan was approved', () => {
  function planFile(contents: string): string {
    const path = join(mkdtempSync(join(tmpdir(), 'plan-')), 'plan.out')
    writeFileSync(path, contents)
    return path
  }

  it('approves a file matching the recorded hash', () => {
    const path = planFile('binary plan')
    const body = commentBody({ plan_out_hash: planOutHash(path, ISSUE) })
    expect(isBinaryPlanApproved(path, parseComment(body)!, ISSUE)).toBe(true)
  })

  it('rejects a different file', () => {
    const body = commentBody({ plan_out_hash: planOutHash(planFile('reviewed'), ISSUE) })
    expect(isBinaryPlanApproved(planFile('substituted'), parseComment(body)!, ISSUE)).toBe(false)
  })

  /**
   * A binary plan has no text to compare, so an unhashed comment cannot approve
   * it. Falling back to text here would approve anything.
   */
  it('refuses when no hash was recorded', () => {
    const body = commentBody({})
    expect(isBinaryPlanApproved(planFile('anything'), parseComment(body)!, ISSUE)).toBe(false)
  })
})

/**
 * Reading a plan out of somebody else's comment would let anyone who can comment
 * on the pull request authorise an apply.
 */
describe('finding our own comment', () => {
  const headers = { workspace: 'default', closed: undefined }

  it('finds a comment written by the token user', async () => {
    const client = clientWith([
      { url: `${ISSUE}/comments/1`, issue_url: ISSUE, body: commentBody(), user: { login: 'me' } },
    ])

    const found = await findPlanComment(client, ISSUE, headers)
    expect(found?.url).toBe(`${ISSUE}/comments/1`)
  })

  it('ignores a comment written by somebody else', async () => {
    const client = clientWith([
      {
        url: `${ISSUE}/comments/1`,
        issue_url: ISSUE,
        body: commentBody({ plan_hash: planHash(PLAN, ISSUE) }),
        user: { login: 'someone-else' },
      },
    ])

    await expect(findPlanComment(client, ISSUE, headers)).resolves.toBeUndefined()
  })

  it('ignores a comment for a different workspace', async () => {
    const client = clientWith([
      {
        url: `${ISSUE}/comments/1`,
        issue_url: ISSUE,
        body: commentBody({ workspace: 'staging' }),
        user: { login: 'me' },
      },
    ])

    await expect(findPlanComment(client, ISSUE, headers)).resolves.toBeUndefined()
  })

  it('ignores comments that are not ours at all', async () => {
    const client = clientWith([
      { url: `${ISSUE}/comments/1`, issue_url: ISSUE, body: 'LGTM', user: { login: 'me' } },
    ])

    await expect(findPlanComment(client, ISSUE, headers)).resolves.toBeUndefined()
  })

  it('returns nothing when there are no comments', async () => {
    await expect(findPlanComment(clientWith([]), ISSUE, headers)).resolves.toBeUndefined()
  })
})
