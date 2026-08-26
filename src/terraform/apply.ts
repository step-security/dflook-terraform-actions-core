import * as core from '@actions/core'
import { runTool } from './exec.js'
import { getLockInfo } from './lock.js'
import { Masker, maskOptionsFromEnv } from './mask.js'

/**
 * Running `terraform apply`.
 *
 * There are two shapes, and which one is used is not a preference:
 *
 * - **From a saved plan.** The plan file is the approval, so no `-auto-approve`
 *   is needed and nothing can be applied that was not in the plan that was
 *   reviewed.
 * - **Auto-approved, from arguments.** The remote backend cannot save a plan, so
 *   there is no file to apply and the apply has to regenerate the plan itself.
 *   Since nothing reviewed it, this needs `-auto-approve` and is only reachable
 *   when the caller asked for it.
 */

export type ApplyFailure = 'state-locked' | 'apply-failed'

export interface ApplyOptions {
  binary: string
  modulePath: string
  /** Saved plan to apply. When absent, the apply regenerates the plan itself. */
  planOut?: string
  parallelism?: string[]
  /** Plan arguments, used only when there is no saved plan to apply. */
  args?: string[]
  env?: NodeJS.ProcessEnv
}

export interface ApplyResult {
  exitCode: number
  /** Apply output, with sensitive values masked. Safe to publish. */
  output: string
  stderr: string
  /** Set when the apply failed, saying whether it was the state lock. */
  failure?: ApplyFailure
  /** Lock holder details, when the failure was a lock. */
  lockInfo?: Record<string, string>
}

/**
 * Applies a plan, or regenerates and applies one when no plan file exists.
 *
 * A non-zero exit is classified rather than just reported, because a state lock
 * is a transient condition a workflow may want to retry, while a failed apply is
 * not.
 */
export async function runApply(options: ApplyOptions): Promise<ApplyResult> {
  const args = ['apply', '-input=false', '-no-color', '-lock-timeout=300s']

  if (options.planOut) {
    args.push(...(options.parallelism ?? []))
    // The saved plan already encodes the arguments it was built with, and
    // passing them again is an error.
    args.push(options.planOut)
  } else {
    // Nothing reviewed this, so it has to be approved explicitly.
    args.push('-auto-approve')
    args.push(...(options.parallelism ?? []))
    args.push(...(options.args ?? []))
  }

  const result = await runTool(options.binary, args, {
    cwd: options.modulePath,
    env: options.env,
    // Captured rather than echoed: it has to be masked before anyone sees it.
    silent: true,
  })

  const masked = new Masker(maskOptionsFromEnv(options.env ?? process.env)).text(result.stdout)
  if (masked.trim()) core.info(masked.trimEnd())
  if (result.stderr.trim()) core.error(result.stderr.trimEnd())

  if (result.exitCode === 0) {
    return { exitCode: 0, output: masked, stderr: result.stderr }
  }

  const lockInfo = getLockInfo(result.stderr)
  return {
    exitCode: result.exitCode,
    output: masked,
    stderr: result.stderr,
    failure: lockInfo ? 'state-locked' : 'apply-failed',
    lockInfo,
  }
}

/**
 * True when a cloud apply failed only because the saved plan had no changes.
 *
 * Terraform Cloud rejects applying an empty plan. Nothing is wrong in that case,
 * so it is treated as success rather than a failure.
 */
export function savedPlanHasNoChanges(stderr: string): boolean {
  return /Error: Saved plan has no changes/.test(stderr)
}

/**
 * Trims the preamble from plan or apply output.
 *
 * The saved text is published as an artifact and compared against the plan in a
 * pull request comment, so it has to be stable between runs. The lock messages
 * in particular appear only sometimes, and leaving them in would make two
 * identical plans compare as different.
 */
const PLAN_STARTS = [
  'Terraform used the selected providers',
  'OpenTofu used the selected providers',
  'An execution plan has been generated and is shown below',
  'No changes',
  'Error',
  'Changes to Outputs:',
  'Terraform will perform the following actions:',
  'OpenTofu will perform the following actions:',
]

const TRANSIENT = [
  'Releasing state lock. This may take a few moments...',
  'Acquiring state lock. This may take a few moments...',
]

export function compactPlan(output: string): string {
  const trailing = output.endsWith('\n')
  const lines = (trailing ? output.slice(0, -1) : output).split('\n')

  let started = false
  const kept: string[] = []
  const buffered: string[] = []

  for (const line of lines) {
    if (!started && PLAN_STARTS.some((prefix) => line.startsWith(prefix))) {
      started = true
    }

    if (started) {
      if (!TRANSIENT.some((prefix) => line.startsWith(prefix))) kept.push(line)
    } else {
      buffered.push(line)
    }
  }

  // Nothing recognisable as a plan: return the output untouched rather than
  // nothing at all, so an unexpected format is still visible.
  const result = started ? kept : buffered
  return trailing ? `${result.join('\n')}\n` : result.join('\n')
}
