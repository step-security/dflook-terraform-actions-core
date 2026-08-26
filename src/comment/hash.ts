import { createHash } from 'crypto'
import { readFileSync } from 'fs'

/**
 * Deciding whether a plan was approved.
 *
 * An apply without `auto_approve` is authorised by a plan that was already
 * posted to a pull request and reviewed there. This module decides whether the
 * plan about to be applied is that same plan.
 *
 * That makes it the security boundary of the apply action: if it says yes to a
 * plan nobody reviewed, the action applies unreviewed changes. Two properties
 * carry that weight.
 *
 * **The hash is salted with the pull request URL.** Without it, a plan hash from
 * one pull request would authorise the identical plan in another, so a plan
 * approved somewhere harmless could be replayed somewhere that matters.
 *
 * **Normalisation is deliberately narrow.** Only text Terraform varies between
 * identical runs is removed. Anything broader would start treating genuinely
 * different plans as equal, which is the failure that matters here — a plan that
 * is wrongly rejected costs a re-run, one that is wrongly accepted applies
 * changes nobody saw.
 */

/**
 * Domain separator for every hash here.
 *
 * Kept as upstream's literal on purpose. It is a namespace rather than a secret,
 * and a repository migrating to this action may have an open pull request whose
 * plan comment was written by upstream. Changing it would make those plans stop
 * being applyable, with the misleading message that the plan does not match.
 */
const HASH_NAMESPACE = 'dflook/terraform-github-actions'

/** Hashes a value, bound to one pull request. */
export function commentHash(value: string | Buffer, salt: string): string {
  const hash = createHash('sha256')
  hash.update(`${HASH_NAMESPACE}/${salt}`)
  hash.update(value)
  return hash.digest('hex')
}

/**
 * Drops the "unchanged attributes hidden" comments.
 *
 * Terraform prints these as a summary of what it is not showing, and the count
 * can differ between runs without the plan differing.
 */
export function removeUnchangedAttributes(plan: string): string {
  return plan
    .split('\n')
    .filter((line) => !/^\s+# \(\d+ unchanged attributes hidden\)/.test(line))
    .join('\n')
    .trim()
}

/**
 * Drops warnings printed after the plan summary.
 *
 * Deprecation warnings and the like appear after `Plan: N to add` and vary with
 * the provider version rather than with the plan. Warnings *before* the summary
 * are kept, since they are part of what was reviewed.
 */
export function removeWarnings(plan: string): string {
  const kept: string[] = []
  let summaryReached = false

  for (const line of plan.split('\n')) {
    // `╷` opens the box Terraform draws around a diagnostic.
    if (summaryReached && (line.startsWith('Warning') || line.startsWith('╷'))) break

    kept.push(line)

    if (/^Plan: \d+ to \S+/.test(line)) summaryReached = true
  }

  return kept.join('\n').trim()
}

/** Normalises plan text so two runs of the same plan compare equal. */
export function normalisePlan(planText: string): string {
  return removeWarnings(removeUnchangedAttributes(planText))
}

/**
 * Hashes plan text, bound to one pull request.
 *
 * Normalised first, so incidental differences between two runs of the same plan
 * do not stop an approved plan from being applied.
 */
export function planHash(planText: string, salt: string): string {
  return commentHash(normalisePlan(planText), salt)
}

/**
 * Hashes a saved plan file, bound to one pull request.
 *
 * A binary plan needs no normalisation: it either is the reviewed plan, byte for
 * byte, or it is not.
 */
export function planOutHash(planPath: string, salt: string): string {
  return commentHash(readFileSync(planPath), salt)
}

/** Compares two plans as text, for comments with no recorded hash. */
export function planTextMatches(a: string, b: string): boolean {
  return a.trim() === b.trim()
}
