/**
 * Reading and writing the plan comment on a pull request.
 *
 * The comment is both the thing a human reviews and the record the apply reads
 * back to decide whether the plan was approved, so its format is a contract
 * rather than presentation. Two parts are load-bearing:
 *
 * - **The HTML comment header.** A hidden JSON object identifying which
 *   configuration the comment belongs to: workspace, label, backend, and a hash
 *   of the plan. A pull request touching several modules gets several comments,
 *   and this is the only thing distinguishing them. Getting it wrong means
 *   updating the wrong comment, or approving a plan from a different module.
 * - **The fenced block inside `<details>`.** The plan text is read back out of
 *   here for comments written before plan hashes existed, so the delimiters have
 *   to round-trip exactly.
 *
 * The format matches upstream's, including the marker string, so a comment
 * written by either action is readable by the other.
 */

/** Marker identifying our comments. Matches upstream so comments interoperate. */
const MARKER = 'dflook/terraform-github-actions'

/** Plans shorter than this are shown expanded rather than collapsed. */
const DEFAULT_COLLAPSE_THRESHOLD = 10

export interface CommentHeaders {
  [key: string]: string | undefined
}

export interface ParsedComment {
  /** Hidden identifying values. */
  headers: CommentHeaders
  /** Text above the collapsible section. */
  description: string
  /** Text on the collapsed summary line. */
  summary: string
  /** Language tag on the fenced block. */
  bodyHighlighting: string
  /** The plan itself. */
  body: string
  /** Text below the collapsible section. */
  status: string
}

/**
 * Structure of a rendered comment.
 *
 * Written as one regex so parsing is the exact inverse of rendering. `[\s\S]` is
 * used throughout rather than `.` with a dotall flag, so the pattern reads the
 * same as it behaves.
 */
const COMMENT = new RegExp(
  [
    '^(?<headers><!--[\\s\\S]*?-->\\n)?',
    '(?<description>[\\s\\S]*?)',
    '<details(?:\\sopen)?>\\s*',
    '(?:<summary>(?<summary>[\\s\\S]*?)</summary>\\s*)?',
    '```(?<highlighting>[\\s\\S]*?)\\n',
    '(?<body>[\\s\\S]*)',
    '```\\s*',
    '</details>',
    '(?<status>[\\s\\S]*)$',
  ].join('')
)

const HEADER = new RegExp(`^<!--\\s${MARKER}\\s(?<args>[\\s\\S]*)\\s-->`)

/**
 * Reads the hidden header.
 *
 * Null values are dropped. Some earlier versions wrote them literally, which
 * made a comment unmatchable, and a null was never meaningful anyway.
 */
export function parseHeaders(header: string | undefined): CommentHeaders {
  if (!header) return {}

  const match = HEADER.exec(header.trim())
  if (!match?.groups) return {}

  try {
    const parsed = JSON.parse(match.groups.args) as Record<string, unknown>
    const headers: CommentHeaders = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== null && value !== undefined) headers[key] = String(value)
    }
    return headers
  } catch {
    // A malformed header means the comment is not one of ours to update.
    return {}
  }
}

/** Renders the hidden header. Compact JSON, matching upstream byte for byte. */
export function formatHeaders(headers: CommentHeaders): string {
  return `<!-- ${MARKER} ${JSON.stringify(headers)} -->`
}

/** Parses a comment body, or undefined when it is not one of ours. */
export function parseComment(body: string): ParsedComment | undefined {
  const match = COMMENT.exec(body)
  if (!match?.groups) return undefined

  return {
    headers: parseHeaders(match.groups.headers),
    description: (match.groups.description ?? '').trim(),
    summary: (match.groups.summary ?? '').trim(),
    bodyHighlighting: (match.groups.highlighting ?? '').trim(),
    body: (match.groups.body ?? '').trim(),
    status: (match.groups.status ?? '').trim(),
  }
}

export interface RenderOptions {
  collapseThreshold?: number
}

/**
 * Decides whether the plan is shown expanded.
 *
 * An error is always expanded, since hiding it behind a click is exactly wrong
 * when something needs attention. A short plan is expanded because collapsing
 * five lines helps nobody. A long plan is collapsed so it does not bury the
 * conversation.
 */
function showExpanded(
  comment: Pick<ParsedComment, 'body' | 'summary'>,
  threshold: number
): boolean {
  if (!comment.summary) return true
  if (comment.body.startsWith('Error')) return true
  if (comment.body.includes('Plan:')) {
    return comment.body.split('\n').length < threshold
  }
  return false
}

/** Renders a comment body. The exact inverse of `parseComment`. */
export function renderComment(comment: ParsedComment, options: RenderOptions = {}): string {
  const threshold = options.collapseThreshold ?? DEFAULT_COLLAPSE_THRESHOLD
  const open = showExpanded(comment, threshold) ? ' open' : ''
  const summary = comment.summary ? `<summary>${comment.summary}</summary>` : ''

  let body = `${formatHeaders(comment.headers)}
${comment.description}
<details${open}>
${summary}

\`\`\`${comment.bodyHighlighting}
${comment.body}
\`\`\`
</details>
`

  if (comment.status) body += `\n${comment.status}`

  return body
}

/**
 * Whether a comment is the one we are looking for.
 *
 * A header set to undefined must be *absent* from the comment, which is how a
 * closed comment is told apart from an open one. Extra headers on the comment are
 * ignored, so a newer version adding one does not stop an older comment from
 * matching.
 */
export function matchingHeaders(
  comment: ParsedComment,
  required: Record<string, string | undefined>
): boolean {
  for (const [header, value] of Object.entries(required)) {
    if (value === undefined) {
      if (header in comment.headers) return false
      continue
    }
    if (comment.headers[header] !== value) return false
  }
  return true
}

/** Reads the collapse threshold from the environment, as upstream does. */
export function collapseThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.TF_PLAN_COLLAPSE_LENGTH)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_COLLAPSE_THRESHOLD
}
