import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { compactPlan } from '../src/terraform/apply.js'
import { matchingHeaders, parseComment } from '../src/comment/comment.js'
import { GitHubClient } from '../src/comment/github.js'
import { formatPlanText, planHighlighting } from '../src/comment/plan-formatting.js'
import {
  isApproved,
  isBinaryPlanApproved,
  planCommentHeaders,
  postPlanComment,
} from '../src/comment/plan-comment.js'
import { planSummaryLine } from '../src/terraform/plan-summary.js'

/**
 * Verifies the two halves of the approval mechanism agree.
 *
 * terraform-plan writes a comment; terraform-apply reads it back and decides
 * whether it authorises an apply. Until now each side was only tested against
 * fixtures written alongside it, so a disagreement between them — a header
 * spelled differently, a hash taken over differently normalised text — would not
 * have failed any test. It would instead surface as an apply reporting "the plan
 * has changed" for a plan that had not changed, which is close to undiagnosable
 * from the outside.
 *
 * These tests drive the real write path and the real read path against each
 * other.
 */

const ISSUE = 'https://api.github.com/repos/o/r/issues/1'
const RAW_PLAN = `Acquiring state lock. This may take a few moments...
Terraform used the selected providers to generate the following execution plan.

Terraform will perform the following actions:

  # aws_instance.web will be created
  + resource "aws_instance" "web" {
      + ami = "ami-123"
    }

Plan: 1 to add, 0 to change, 0 to destroy.
`

const IDENTITY = {
  workspace: 'default',
  backendType: 's3',
  backendFingerprint: '{"bucket":"state","key":"terraform.tfstate"}',
}

interface Written {
  created: string[]
  updated: { url: string; body: string }[]
  minimized: string[]
}

/** A client that records what would have been written, and serves it back. */
function recordingClient(existingBody?: string): { client: GitHubClient; written: Written } {
  const written: Written = { created: [], updated: [], minimized: [] }

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const target = String(url)
    const method = init?.method ?? 'GET'
    const payload = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {}

    if (target.includes('graphql')) {
      if (typeof payload.query === 'string' && payload.query.includes('minimizeComment')) {
        written.minimized.push('called')
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: {} }) }
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data: { viewer: { login: 'me' } } }),
      }
    }

    if (method === 'POST') {
      written.created.push(payload.body)
      return {
        ok: true,
        status: 201,
        headers: new Headers(),
        json: async () => ({ url: `${ISSUE}/comments/9`, issue_url: ISSUE, body: payload.body }),
      }
    }

    if (method === 'PATCH') {
      written.updated.push({ url: target, body: payload.body })
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ url: target, issue_url: ISSUE, body: payload.body }),
      }
    }

    // Listing comments.
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () =>
        existingBody
          ? [
              {
                url: `${ISSUE}/comments/1`,
                issue_url: ISSUE,
                node_id: 'IC_node1',
                body: existingBody,
                user: { login: 'me' },
              },
            ]
          : [],
    }
  }) as unknown as typeof fetch

  return { client: new GitHubClient({ token: 't', fetchImpl }), written }
}

/** Runs the plan-side write exactly as the plan action will. */
async function writePlan(
  client: GitHubClient,
  options: {
    planText?: string
    changes?: boolean
    mode?: 'true' | 'changes-only' | 'always-new'
    planOut?: string
    existing?: Parameters<typeof postPlanComment>[0]['existing']
  } = {}
): Promise<void> {
  const planText = compactPlan(options.planText ?? RAW_PLAN)
  const changes = options.changes ?? true
  const { format, text } = formatPlanText(planText)

  await postPlanComment({
    client,
    issueUrl: ISSUE,
    mode: options.mode ?? 'true',
    headers: planCommentHeaders(IDENTITY, ISSUE),
    existing: options.existing,
    description: 'Terraform plan in `infra`',
    planText,
    body: text,
    bodyFormat: format,
    bodyHighlighting: planHighlighting(format, changes),
    summary: planSummaryLine(planText, changes),
    status: ':memo: Plan generated',
    changes,
    planOut: options.planOut,
  })
}

describe('a plan comment approves the plan it was written for', () => {
  it('is accepted by the apply side', async () => {
    const { client, written } = recordingClient()
    await writePlan(client)

    const posted = parseComment(written.created[0])!
    // What the apply action passes: the plan it just generated, compacted.
    expect(isApproved(compactPlan(RAW_PLAN), posted, ISSUE)).toBe(true)
  })

  /**
   * The lock lines appear only sometimes. If the two sides normalised
   * differently, an unchanged plan would be reported as changed.
   */
  it('is accepted when the lock noise differs between runs', async () => {
    const { client, written } = recordingClient()
    await writePlan(client)

    const posted = parseComment(written.created[0])!
    const withoutLockLine = RAW_PLAN.split('\n').slice(1).join('\n')
    expect(isApproved(compactPlan(withoutLockLine), posted, ISSUE)).toBe(true)
  })

  it('rejects a plan that actually changed', async () => {
    const { client, written } = recordingClient()
    await writePlan(client)

    const posted = parseComment(written.created[0])!
    const different = RAW_PLAN.replace('1 to add', '7 to destroy')
    expect(isApproved(compactPlan(different), posted, ISSUE)).toBe(false)
  })

  /** Truncation is presentation; the hash is over the full plan. */
  it('is accepted even when the displayed body was truncated', async () => {
    const huge = `${RAW_PLAN}\n${Array.from({ length: 5000 }, (_, i) => `  + big_${i} = "x"`).join('\n')}`
    const { client, written } = recordingClient()
    await writePlan(client, { planText: huge })

    const posted = parseComment(written.created[0])!
    expect(posted.headers.plan_text_format).toBe('diff-trunc')
    expect(isApproved(compactPlan(huge), posted, ISSUE)).toBe(true)
  })

  it('records the format it used', async () => {
    const { client, written } = recordingClient()
    await writePlan(client)
    expect(parseComment(written.created[0])!.headers.plan_text_format).toBe('diff')
  })
})

describe('a saved plan file approves the same file', () => {
  function planFile(contents: string): string {
    const path = join(mkdtempSync(join(tmpdir(), 'plan-')), 'plan.out')
    writeFileSync(path, contents)
    return path
  }

  it('is accepted by the apply side', async () => {
    const planOut = planFile('binary plan bytes')
    const { client, written } = recordingClient()
    await writePlan(client, { planOut })

    const posted = parseComment(written.created[0])!
    expect(isBinaryPlanApproved(planOut, posted, ISSUE)).toBe(true)
  })

  it('rejects a different file', async () => {
    const { client, written } = recordingClient()
    await writePlan(client, { planOut: planFile('reviewed') })

    const posted = parseComment(written.created[0])!
    expect(isBinaryPlanApproved(planFile('substituted'), posted, ISSUE)).toBe(false)
  })

  /**
   * A plan run against a backend that cannot save a plan must not leave a stale
   * hash behind, or it would authorise applying a file this run never produced.
   */
  it('records no file hash when no plan was saved', async () => {
    const { client, written } = recordingClient()
    await writePlan(client)

    expect(parseComment(written.created[0])!.headers.plan_out_hash).toBeUndefined()
  })
})

describe('the comment is found by the apply side', () => {
  it('matches the headers apply looks for', async () => {
    const { client, written } = recordingClient()
    await writePlan(client)

    const posted = parseComment(written.created[0])!
    // Exactly what apply builds to find it.
    expect(matchingHeaders(posted, planCommentHeaders(IDENTITY, ISSUE))).toBe(true)
  })

  it('does not match a different workspace', async () => {
    const { client, written } = recordingClient()
    await writePlan(client)

    const posted = parseComment(written.created[0])!
    const other = planCommentHeaders({ ...IDENTITY, workspace: 'staging' }, ISSUE)
    expect(matchingHeaders(posted, other)).toBe(false)
  })

  it('does not match a different backend', async () => {
    const { client, written } = recordingClient()
    await writePlan(client)

    const posted = parseComment(written.created[0])!
    const other = planCommentHeaders(
      { ...IDENTITY, backendFingerprint: '{"bucket":"elsewhere"}' },
      ISSUE
    )
    expect(matchingHeaders(posted, other)).toBe(false)
  })
})

describe('changes-only', () => {
  it('creates nothing for a no-change plan with no existing comment', async () => {
    const { client, written } = recordingClient()
    await writePlan(client, { mode: 'changes-only', changes: false })

    expect(written.created).toHaveLength(0)
    expect(written.updated).toHaveLength(0)
  })

  it('updates an existing comment for a no-change plan', async () => {
    const { client, written } = recordingClient()
    const existing = {
      comment: parseComment(
        (await (async () => {
          const seed = recordingClient()
          await writePlan(seed.client)
          return seed.written.created[0]
        })())
      )!,
      url: `${ISSUE}/comments/1`,
    }

    await writePlan(client, { mode: 'changes-only', changes: false, existing })
    expect(written.updated).toHaveLength(1)
    expect(written.created).toHaveLength(0)
  })

  it('creates a comment when there are changes', async () => {
    const { client, written } = recordingClient()
    await writePlan(client, { mode: 'changes-only', changes: true })
    expect(written.created).toHaveLength(1)
  })
})

/**
 * A superseded comment must stop approving anything, or an old plan could
 * authorise an apply after a newer plan replaced it.
 */
describe('always-new', () => {
  async function seededExisting() {
    const seed = recordingClient()
    await writePlan(seed.client)
    return {
      comment: parseComment(seed.written.created[0])!,
      url: `${ISSUE}/comments/1`,
      nodeId: 'IC_node1',
    }
  }

  it('marks the old comment closed and posts a replacement', async () => {
    const { client, written } = recordingClient()
    await writePlan(client, { mode: 'always-new', existing: await seededExisting() })

    expect(written.updated).toHaveLength(1)
    expect(written.created).toHaveLength(1)

    const superseded = parseComment(written.updated[0].body)!
    expect(superseded.headers.closed).toBe('true')
  })

  it('leaves the superseded comment unable to approve', async () => {
    const { client, written } = recordingClient()
    await writePlan(client, { mode: 'always-new', existing: await seededExisting() })

    const superseded = parseComment(written.updated[0].body)!
    // apply requires `closed` to be absent.
    expect(matchingHeaders(superseded, planCommentHeaders(IDENTITY, ISSUE))).toBe(false)
  })

  it('strikes the old summary and says it is outdated', async () => {
    const { client, written } = recordingClient()
    await writePlan(client, { mode: 'always-new', existing: await seededExisting() })

    const superseded = parseComment(written.updated[0].body)!
    expect(superseded.summary).toContain('<strike>')
    expect(superseded.status).toContain('outdated')
  })

  it('asks for the old comment to be collapsed', async () => {
    const { client, written } = recordingClient()
    await writePlan(client, { mode: 'always-new', existing: await seededExisting() })
    expect(written.minimized).toHaveLength(1)
  })

  it('still posts the replacement when collapsing is unavailable', async () => {
    // No node id, so the collapse is skipped entirely.
    const existing = { ...(await seededExisting()), nodeId: undefined }
    const { client, written } = recordingClient()

    await writePlan(client, { mode: 'always-new', existing })
    expect(written.created).toHaveLength(1)
    expect(written.minimized).toHaveLength(0)
  })

  it('the replacement approves the new plan', async () => {
    const { client, written } = recordingClient()
    await writePlan(client, { mode: 'always-new', existing: await seededExisting() })

    const replacement = parseComment(written.created[0])!
    expect(isApproved(compactPlan(RAW_PLAN), replacement, ISSUE)).toBe(true)
  })
})