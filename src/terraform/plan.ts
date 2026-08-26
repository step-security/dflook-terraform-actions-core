import * as core from '@actions/core'
import { runTool } from './exec.js'
import { Masker, maskOptionsFromEnv } from './mask.js'

/**
 * Running `terraform plan`.
 *
 * The exit code is the result, not an error indicator:
 *
 * - `0` — no changes
 * - `1` — the plan failed
 * - `2` — there are changes to apply
 *
 * That is what `-detailed-exitcode` buys, and losing the distinction between 1
 * and 2 is the one mistake worth guarding against: a broken configuration would
 * be reported as "changes to apply", which reads as a normal outcome.
 */

/** Terraform's documented plan exit codes. */
export const PLAN_NO_CHANGES = 0
export const PLAN_ERROR = 1
export const PLAN_CHANGES = 2

export interface PlanArgsInputs {
  /** Concurrency limit. `0` leaves it to Terraform. */
  parallelism?: string
  /** Resource addresses to restrict the plan to. */
  target?: string
  /** Resource addresses to exclude. */
  exclude?: string
  /** Resource addresses to force replacement of. */
  replace?: string
  /** Plans a destroy. */
  destroy?: boolean
  /** Skips refreshing state before planning. */
  refresh?: boolean
}

export class PlanArgsError extends Error {}

/**
 * Builds the plan arguments common to the actions that plan.
 *
 * `parallelism` is returned separately because it is passed ahead of the
 * user-supplied arguments, and a plan file argument sits between the two.
 */
export function planArgs(inputs: PlanArgsInputs): { parallelism: string[]; args: string[] } {
  const parallelism: string[] = []
  const args: string[] = []

  const limit = Number(inputs.parallelism ?? '0')
  if (Number.isFinite(limit) && limit !== 0) {
    parallelism.push(`-parallelism=${limit}`)
  }

  // Terraform rejects these together, but it does so only after initializing,
  // by which point the failure is buried in output.
  if (inputs.target?.trim() && inputs.exclude?.trim()) {
    throw new PlanArgsError(
      'target and exclude cannot be used together. These flags are mutually exclusive in Terraform.'
    )
  }

  for (const [flag, value] of [
    ['-target', inputs.target],
    ['-exclude', inputs.exclude],
    ['-replace', inputs.replace],
  ] as const) {
    for (const address of splitAddresses(value)) {
      args.push(flag, address)
    }
  }

  if (inputs.destroy) args.push('-destroy')
  if (inputs.refresh === false) args.push('-refresh=false')

  return { parallelism, args }
}

function splitAddresses(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export interface PlanOptions {
  binary: string
  modulePath: string
  /** Where to save the plan. Omitted for backends that cannot save one. */
  planOut?: string
  parallelism?: string[]
  args?: string[]
  /** Runs without taking a state lock, for a read-only plan. */
  lock?: boolean
  env?: NodeJS.ProcessEnv
}

export interface PlanResult {
  exitCode: number
  /** Plan output, with sensitive values masked. Safe to publish. */
  output: string
  /** Plan output as Terraform produced it. Never publish this. */
  rawOutput: string
  stderr: string
}

/**
 * Runs a plan and returns its output with sensitive values masked.
 *
 * The masked and unmasked forms are both returned, but only the masked one is
 * printed here. Anything that publishes plan output — a log, a pull request
 * comment — must use `output`; `rawOutput` exists for comparing against a
 * previous plan, where masking would make two different plans look identical.
 */
export async function runPlan(options: PlanOptions): Promise<PlanResult> {
  const args = [
    'plan',
    '-input=false',
    '-no-color',
    '-detailed-exitcode',
    '-lock-timeout=300s',
    ...(options.parallelism ?? []),
  ]

  if (options.planOut) args.push(`-out=${options.planOut}`)
  if (options.lock === false) args.push('-lock=false')
  args.push(...(options.args ?? []))

  const result = await runTool(options.binary, args, {
    cwd: options.modulePath,
    env: options.env,
    // Captured rather than echoed: it has to be masked before anyone sees it.
    silent: true,
  })

  const masked = new Masker(maskOptionsFromEnv(options.env ?? process.env)).text(result.stdout)

  if (masked.trim()) core.info(masked.trimEnd())

  return {
    exitCode: result.exitCode,
    output: masked,
    rawOutput: result.stdout,
    stderr: result.stderr,
  }
}

/**
 * True when a plan failed only because the backend refuses to save one.
 *
 * The remote backend cannot write a plan file. Retrying without `-out` gets a
 * usable result, so this is worth telling apart from a real failure.
 */
export function cannotSavePlan(stderr: string): boolean {
  return /Saving a generated plan is currently not supported/.test(stderr)
}
