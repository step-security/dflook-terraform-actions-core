/**
 * Preparing plan text for a pull request comment.
 *
 * Two concerns, both about the comment rather than the plan:
 *
 * - **Diff rendering.** Terraform indents the operation character, so
 *   `  + resource` reads as plain text. Moving it to column zero makes GitHub
 *   colour the line, which is the difference between a readable plan and a wall
 *   of monospace.
 * - **Size.** A comment body has a hard limit, so a large plan is truncated with
 *   a pointer to the full text in the log.
 *
 * Neither affects approval. The hash is taken over the plan text as Terraform
 * produced it, before any of this, so reformatting cannot make an approved plan
 * stop matching.
 */

/**
 * Largest plan body to put in a comment, in bytes.
 *
 * Below GitHub's own limit, leaving room for the header, description, summary
 * and status that wrap it.
 */
const MAX_BODY_BYTES = 50_000

const TOO_LARGE = 'Plan is too large to fit in a PR comment. See the full plan in the workflow log.'

/**
 * Splits into lines the way Python's `splitlines` does.
 *
 * The difference that matters: for text ending in a newline, `split('\n')`
 * yields a final empty element and `splitlines` does not. Since these functions
 * rejoin with `\n`, keeping it would add a trailing blank line that upstream
 * does not produce — enough to make otherwise identical output differ.
 */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** How the body was rendered, recorded in the comment header. */
export type PlanTextFormat = 'diff' | 'diff-trunc' | 'text' | 'trunc'

/**
 * Moves the operation character to the start of the line.
 *
 * Heredoc bodies are passed through untouched. A heredoc can contain anything,
 * including lines that begin with `-` or `+`, and rewriting those would corrupt
 * the value being shown.
 */
export function formatDiff(planText: string): string {
  const lines: string[] = []
  let inHeredoc = false

  for (const line of splitLines(planText)) {
    if (inHeredoc) {
      if (line.trimStart().startsWith('EOT')) inHeredoc = false
      lines.push(line)
      continue
    }

    if (line.endsWith('EOT')) inHeredoc = true

    // `  ~ attribute` becomes `~  attribute`, so the marker is in column zero.
    let replaced = line.replace(/^(\s+)([-+/~]+)(.*)/, '$2$1$3')

    // `~` alone is not a diff marker to GitHub, but `!` is, and it renders in
    // the same colour as a modification.
    if (replaced.startsWith('~ ')) replaced = `!~${replaced.slice(2)}`

    // Same treatment for the "N unchanged attributes hidden" comments.
    // Anchored: unanchored, a long run of spaces with no `# ` retries the
    // match from every position. Terraform always indents this at line start.
    replaced = replaced.replace(/^(\s+)# (\(.*hidden)/, '#$1$2')

    lines.push(replaced)
  }

  return lines.join('\n')
}

/**
 * Cuts text to a byte budget on a line boundary.
 *
 * Measured in bytes rather than characters, because that is what the limit is:
 * a plan full of multi-byte characters would otherwise be cut too late.
 */
export function truncate(text: string, maxBytes: number, message: string): string {
  const lines: string[] = []
  let total = 0

  for (const line of splitLines(text)) {
    const size = Buffer.byteLength(line) + 1 // the newline
    if (total + size > maxBytes) {
      lines.push(message)
      break
    }
    lines.push(line)
    total += size
  }

  return lines.join('\n')
}

/**
 * Renders plan text for a comment, reporting which form was used.
 *
 * The format is recorded in the comment header so a later run can tell how the
 * body was produced without having to guess from its contents.
 */
export function formatPlanText(
  planText: string,
  formatType = 'diff'
): { format: PlanTextFormat; text: string } {
  if (formatType === 'diff') {
    const text = formatDiff(planText)
    return Buffer.byteLength(text) > MAX_BODY_BYTES
      ? { format: 'diff-trunc', text: truncate(text, MAX_BODY_BYTES, TOO_LARGE) }
      : { format: 'diff', text }
  }

  return Buffer.byteLength(planText) > MAX_BODY_BYTES
    ? { format: 'trunc', text: truncate(planText, MAX_BODY_BYTES, TOO_LARGE) }
    : { format: 'text', text: planText }
}

/** Language tag for the fenced block, so GitHub highlights it. */
export function planHighlighting(format: PlanTextFormat, changes: boolean): string {
  // Nothing to colour when there are no changes.
  if (!changes) return ''
  return format.startsWith('diff') ? 'diff' : 'hcl'
}