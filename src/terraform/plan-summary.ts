/**
 * Reading the summary out of plan text.
 *
 * Two things come from here: the operation counts published as outputs, and the
 * one-line summary shown on the collapsed pull request comment.
 *
 * Both parse rendered output rather than the JSON plan. That is what upstream
 * does, and it is worth matching: the counts a workflow branches on should be
 * the counts a human reads in the comment, not a separately derived number that
 * might disagree.
 */

export interface PlanCounts {
  add: number
  change: number
  destroy: number
  move: number
  import: number
}

/** `  # module.a.thing has moved to module.b.thing` */
const MOVED = /^ {2}# \S+ has moved to \S+$/

/** The `N to <operation>` pairs inside a `Plan:` line. */
const OPERATION = /(\d+) to (\w+)/g

/**
 * Counts the operations a plan will perform.
 *
 * Moves are a special case. Terraform includes them in the summary line only in
 * some versions, so when the line does not mention them the individual
 * "has moved to" lines are counted instead. Reporting zero moves for a plan that
 * moves things would be worse than the redundant scan.
 */
export function planCounts(planText: string): PlanCounts {
  const counts: PlanCounts = { add: 0, change: 0, destroy: 0, move: 0, import: 0 }
  let summaryMentionsMoves = false
  let countedMoves = 0

  for (const line of planText.split('\n')) {
    if (MOVED.test(line)) countedMoves += 1

    if (!line.startsWith('Plan:')) continue

    for (const match of line.matchAll(OPERATION)) {
      const operation = match[2]
      if (operation in counts) {
        counts[operation as keyof PlanCounts] = Number(match[1])
        if (operation === 'move') summaryMentionsMoves = true
      }
    }
  }

  if (!summaryMentionsMoves) counts.move = countedMoves

  return counts
}

/**
 * Builds the line shown when the plan is collapsed.
 *
 * Deliberately more than just the `Plan:` line. An error or a no-op has to say
 * so without being expanded; output-only changes produce no `Plan:` line at
 * all; and Terraform 1.4 stopped printing the summary in some cases, so there is
 * a fallback rather than an empty summary.
 */
export function planSummaryLine(planText: string, changes = true): string {
  let summary: string | undefined
  let countedMoves = 0

  for (const line of planText.split('\n')) {
    // An error or "no changes" is the whole story; nothing later improves on it.
    if (line.startsWith('No changes') || line.startsWith('Error')) return line

    if (MOVED.test(line)) countedMoves += 1

    if (line.startsWith('Plan:')) {
      summary = line
      if (countedMoves > 0 && !summary.includes('move')) {
        summary = `${summary.replace(/\.$/, '')}, ${countedMoves} to move.`
      }
    }

    if (line.startsWith('Changes to Outputs')) {
      return summary ? `${summary} Changes to Outputs.` : 'Changes to Outputs.'
    }
  }

  if (summary) return summary

  // Terraform 1.4.0 stopped printing the summary in some cases.
  return changes ? 'Plan generated.' : 'No changes.'
}