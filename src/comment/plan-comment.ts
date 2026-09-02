import { createHash } from 'crypto'
import { canonicalJson } from './backend-fingerprint.js'
import { matchingHeaders, parseComment, renderComment } from './comment.js'
import type { CommentHeaders, ParsedComment } from './comment.js'
import { GitHubClient } from './github.js'
import { commentHash, planHash, planOutHash, planTextMatches } from './hash.js'

/**
 * Finding the plan comment for one configuration, and deciding whether the plan
 * it holds approves an apply.
 *
 * This is the glue between the parts: the header identifies which configuration
 * a comment belongs to, and the recorded hash says which plan was reviewed. Both
 * have to agree before an apply proceeds without `auto_approve`.
 */

export interface PlanIdentity {
  /** Workspace the plan was made in. */
  workspace: string
  /** Optional label distinguishing several runs on the same configuration. */
  label?: string
  /** Backend type, or empty for a local backend. */
  backendType?: string
  /** Fingerprint bytes from `backendFingerprint`. */
  backendFingerprint: string
  /** Arguments that change what the plan contains. */
  planModifier?: PlanModifier
}

export interface PlanModifier {
  target?: string
  exclude?: string
  replace?: string
  destroy?: boolean
}

/** Splits and sorts an address list so ordering does not change the identity. */
function sortedAddresses(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const entries = value
    .replace(/,/g, '\n')
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort()
  return entries.length > 0 ? entries : undefined
}

/**
 * Hashes the arguments that change what a plan contains.
 *
 * A plan restricted with `-target` is not the same plan as an unrestricted one,
 * so it must not match the same comment. Sorted first, because the order the
 * targets were listed in does not change the plan.
 */
export function planModifierHash(modifier: PlanModifier): string | undefined {
  const fields: Record<string, unknown> = {}

  const target = sortedAddresses(modifier.target)
  if (target) fields.target = target

  const exclude = sortedAddresses(modifier.exclude)
  if (exclude) fields.exclude = exclude

  const replace = sortedAddresses(modifier.replace)
  if (replace) fields.replace = replace

  if (modifier.destroy) fields.destroy = 'true'

  if (Object.keys(fields).length === 0) return undefined

  return createHash('sha256').update(canonicalJson(fields)).digest('hex')
}

/**
 * Builds the headers identifying a comment.
 *
 * `closed` is required to be absent, which is how an open comment is told from
 * one that has been superseded.
 *
 * The `cloud` backend is recorded as `remote`, matching upstream. They are the
 * same state as far as identity goes, and recording them differently would make
 * a comment stop matching when a configuration moves between the two spellings.
 */
export function planCommentHeaders(
  identity: PlanIdentity,
  issueUrl: string
): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {
    workspace: identity.workspace,
    closed: undefined,
  }

  if (identity.backendType) {
    headers.backend_type = identity.backendType === 'cloud' ? 'remote' : identity.backendType
  }

  headers.label = identity.label || undefined

  if (identity.planModifier) {
    const modifier = planModifierHash(identity.planModifier)
    if (modifier) headers.plan_modifier = modifier
  }

  headers.backend = commentHash(identity.backendFingerprint, issueUrl)

  return headers
}

export interface FoundComment {
  comment: ParsedComment
  /** API url of the comment, for updating it in place. */
  url: string
  /** GraphQL node id, needed to collapse the comment. Absent on older payloads. */
  nodeId?: string
}

/**
 * Finds our comment for this configuration on the pull request.
 *
 * Only comments written by the token's own user are considered. Reading a plan
 * out of somebody else's comment would let anyone who can comment on the pull
 * request authorise an apply.
 */
export async function findPlanComment(
  client: GitHubClient,
  issueUrl: string,
  headers: Record<string, string | undefined>
): Promise<FoundComment | undefined> {
  const username = await client.currentUser()
  const comments = await client.listComments(issueUrl)

  for (const raw of comments) {
    if (raw.user?.login !== username) continue

    const parsed = parseComment(raw.body)
    if (!parsed) continue
    if (!matchingHeaders(parsed, headers)) continue

    return { comment: parsed, url: raw.url, nodeId: raw.node_id }
  }

  return undefined
}

/**
 * Whether the comment approves this plan.
 *
 * Prefers the recorded hash, which is bound to the pull request. Comments
 * written before hashes existed carry only the plan text, so those fall back to
 * comparing it — weaker, but the alternative is refusing to apply a plan that
 * was legitimately reviewed.
 */
export function isApproved(
  proposedPlan: string,
  comment: ParsedComment,
  issueUrl: string
): boolean {
  const recorded = comment.headers.plan_hash
  if (recorded) {
    return planHash(proposedPlan, issueUrl) === recorded
  }
  return planTextMatches(proposedPlan, comment.body)
}

/**
 * Whether the comment approves this saved plan file.
 *
 * A binary plan has no text to fall back on, so a comment with no recorded hash
 * cannot approve it.
 */
export function isBinaryPlanApproved(
  planPath: string,
  comment: ParsedComment,
  issueUrl: string
): boolean {
  const recorded = comment.headers.plan_out_hash
  if (!recorded) return false
  return planOutHash(planPath, issueUrl) === recorded
}

export interface UpdateOptions {
  client: GitHubClient
  issueUrl: string
  headers: CommentHeaders
  description: string
  summary: string
  body: string
  bodyHighlighting?: string
  status: string
  /** Existing comment to edit, if one was found. */
  existing?: FoundComment
}

/**
 * Writes or edits the plan comment.
 *
 * Editing in place rather than adding a comment each run, so a pull request
 * shows the current plan rather than a history of every attempt.
 */
export async function writePlanComment(options: UpdateOptions): Promise<void> {
  const body = renderComment({
    headers: options.headers,
    description: options.description,
    summary: options.summary,
    bodyHighlighting: options.bodyHighlighting ?? 'hcl',
    body: options.body,
    status: options.status,
  })

  if (options.existing) {
    await options.client.updateComment(options.existing.url, body)
    return
  }

  await options.client.createComment(options.issueUrl, body)
}

/** How `add_github_comment` was set. */
export type CommentMode = 'true' | 'changes-only' | 'always-new' | 'false'

/** True when the mode asks for a comment at all. */
export function commentRequested(mode: string | undefined): boolean {
  return mode === 'true' || mode === 'changes-only' || mode === 'always-new'
}

export interface PostPlanOptions {
  client: GitHubClient
  issueUrl: string
  mode: CommentMode
  /** Headers identifying this configuration, from `planCommentHeaders`. */
  headers: Record<string, string | undefined>
  /** Existing comment for this configuration, if there is one. */
  existing?: FoundComment
  /** Text above the collapsible section, naming the configuration. */
  description: string
  /** Plan text as Terraform produced it. Hashed, and shown after formatting. */
  planText: string
  /** Body to display, already formatted. */
  body: string
  /** Format tag recorded in the header. */
  bodyFormat: string
  bodyHighlighting: string
  summary: string
  status: string
  /** Whether the plan has changes, which decides some of the above. */
  changes: boolean
  /** Saved plan file, hashed so an apply can verify the binary plan. */
  planOut?: string
  /** Reference to the job that produced this, recorded for traceability. */
  planJobRef?: string
}

/**
 * Posts or updates the plan comment.
 *
 * The recorded hashes are what an apply later checks against, so this is the
 * write half of the approval mechanism. Three behaviours the mode selects:
 *
 * - `true` — keep one comment per configuration, edited in place.
 * - `changes-only` — the same, except a plan with no changes will update an
 *   existing comment but never create one. A pull request that never had a plan
 *   does not get a comment just to say nothing is happening.
 * - `always-new` — supersede the previous comment and post a replacement, so the
 *   newest plan is the newest comment.
 */
export async function postPlanComment(options: PostPlanOptions): Promise<void> {
  let existing = options.existing

  // A no-change plan under changes-only updates an existing comment but does
  // not create one.
  const onlyIfExists = options.mode === 'changes-only' && !options.changes
  if (!existing && onlyIfExists) return

  if (options.mode === 'always-new' && existing) {
    await supersede(options.client, existing)
    existing = undefined
  }

  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.headers)) {
    if (value !== undefined) headers[key] = value
  }

  if (options.planJobRef) headers.plan_job_ref = options.planJobRef

  // Hash the plan as Terraform produced it, not as displayed. Formatting and
  // truncation are presentation, and hashing the displayed form would make a
  // truncated plan unapprovable.
  headers.plan_hash = planHash(options.planText, options.issueUrl)
  headers.plan_text_format = options.bodyFormat

  if (options.planOut) {
    headers.plan_out_hash = planOutHash(options.planOut, options.issueUrl)
  } else {
    // A stale hash would authorise applying a plan file this run never made.
    delete headers.plan_out_hash
  }

  await writePlanComment({
    client: options.client,
    issueUrl: options.issueUrl,
    headers,
    description: options.description,
    summary: options.summary,
    body: options.body,
    bodyHighlighting: options.bodyHighlighting,
    status: options.status,
    existing,
  })
}

/**
 * Marks a comment as superseded.
 *
 * The `closed` header is what matters: an apply requires it to be absent, so
 * setting it stops this comment approving anything. Striking the summary and
 * collapsing the comment are presentation, and the collapse is best effort
 * because it needs GraphQL, which not every token can use.
 */
async function supersede(client: GitHubClient, existing: FoundComment): Promise<void> {
  await writePlanComment({
    client,
    issueUrl: existing.comment.headers.issue_url ?? '',
    headers: { ...existing.comment.headers, closed: 'true' } as CommentHeaders,
    description: existing.comment.description,
    summary: `<strike>${existing.comment.summary}</strike>`,
    body: existing.comment.body,
    bodyHighlighting: existing.comment.bodyHighlighting,
    status: ':spider_web: Plan is outdated',
    existing,
  })

  await client.minimizeComment(existing.nodeId)
}
