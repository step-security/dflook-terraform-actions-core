import { copyFileSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'

/**
 * Making the `variables` and `var_file` inputs visible to Terraform.
 *
 * Terraform loads any `*.auto.tfvars` in the module directory automatically, so
 * the inputs are materialised as files there rather than passed as flags. That
 * is what lets them apply to every command — including ones we do not invoke
 * directly, like a `terraform plan` run inside `terraform apply`.
 *
 * Two details are load-bearing:
 *
 * - **The `zzzz-` prefix.** Terraform loads auto tfvars in lexical order and
 *   later files win, so the prefix guarantees these override anything the
 *   configuration ships with. Renaming it would silently change precedence.
 * - **`variables` is written last.** It is documented to override `var_file`,
 *   which only holds if its filename sorts after them — hence the counter.
 */

/** Prefix that forces these files to load after any others. */
const PREFIX = 'zzzz-dflook-terraform-github-actions'

export class TfVarsError extends Error {}

export interface TfVarsInputs {
  /** Newline- or comma-separated paths, relative to the workspace. */
  varFile?: string
  /** Literal tfvars content. */
  variables?: string
}

export interface WrittenTfVars {
  /** Files created inside the module directory. */
  created: string[]
}

function paths(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Name for the nth generated file.
 *
 * A `.json` var file keeps JSON syntax, so it has to become
 * `.auto.tfvars.json`; anything else becomes `.auto.tfvars`. Getting this wrong
 * makes Terraform try to parse JSON as HCL.
 */
export function autoTfVarsName(counter: number, sourceName?: string): string {
  const index = String(counter).padStart(2, '0')

  if (!sourceName) return `${PREFIX}-${index}.auto.tfvars`

  if (sourceName.endsWith('.json')) {
    return `${PREFIX}-${index}.${sourceName.slice(0, -'.json'.length)}.auto.tfvars.json`
  }

  const stem = sourceName.endsWith('.tfvars')
    ? sourceName.slice(0, -'.tfvars'.length)
    : sourceName

  return `${PREFIX}-${index}.${stem}.auto.tfvars`
}

/**
 * Copies var files and the variables input into the module directory.
 *
 * A missing var file is fatal: continuing would apply a plan built without
 * values the caller clearly intended to supply.
 */
export function writeAutoTfVars(
  inputs: TfVarsInputs,
  modulePath: string,
  workspaceRoot = process.cwd()
): WrittenTfVars {
  const created: string[] = []
  let counter = 0

  for (const relative of paths(inputs.varFile ?? '')) {
    const source = join(workspaceRoot, relative)

    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new TfVarsError(`var_file does not exist: "${relative}"`)
    }

    const name = autoTfVarsName(counter, basename(source))
    copyFileSync(source, join(modulePath, name))
    created.push(name)
    counter += 1
  }

  if (inputs.variables?.trim()) {
    const name = autoTfVarsName(counter)
    // Trailing newline so appended HCL is never joined onto the last line.
    const content = inputs.variables.endsWith('\n') ? inputs.variables : `${inputs.variables}\n`
    writeFileSync(join(modulePath, name), content)
    created.push(name)
  }

  return { created }
}

/**
 * Matches any generated file, including ones this run did not create.
 *
 * Deliberately not limited to the names just written: a run that was cancelled
 * mid-step leaves files behind, and those would be loaded by the next run as if
 * they had been asked for.
 */
const GENERATED = new RegExp(`^${PREFIX}-\\d+.*\\.auto\\.tfvars(\\.json)?$`)

/**
 * Removes the generated tfvars files from the module.
 *
 * These sit inside the checkout, so leaving them behind would change what a
 * later step in the same job sees, and could put variable values into an
 * uploaded artifact. Must run whether or not the command succeeded.
 */
export function deleteAutoTfVars(modulePath: string): string[] {
  if (!existsSync(modulePath)) return []

  const removed: string[] = []
  for (const entry of readdirSync(modulePath)) {
    if (!GENERATED.test(entry)) continue
    try {
      rmSync(join(modulePath, entry), { force: true })
      removed.push(entry)
    } catch {
      // Cleanup runs on the way out, including after a failure. Losing the
      // original error to report a cleanup problem would hide the real cause.
    }
  }
  return removed
}
