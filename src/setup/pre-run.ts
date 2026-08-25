import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { exec } from '@actions/exec'
import { endGroup, info, startGroup, withWorkflowCommandsStopped } from '../actions/workflow.js'

/**
 * Running the caller's own setup commands before Terraform.
 *
 * `TERRAFORM_PRE_RUN` exists for things that have to happen inside the job but
 * outside Terraform — installing a provider plugin from a private registry,
 * fetching a certificate, configuring a proxy.
 *
 * The script runs with `-x` so each command appears in the log, and with `-e`
 * and `-o pipefail` so a failure stops the run rather than proceeding into
 * Terraform with a half-finished environment.
 */

export class PreRunError extends Error {}

export interface PreRunOptions {
  /** Directory to write the script into. Defaults to a fresh temp directory. */
  scriptDir?: string
  /** Interpreter. Defaults to bash. */
  shell?: string
}

/**
 * Executes `TERRAFORM_PRE_RUN`, if set.
 *
 * Workflow commands are suspended for the duration. The script's output is
 * entirely under the caller's control, and without suspending them a line of
 * output could masquerade as an instruction to the runner — setting an output,
 * adding a mask, or exporting an environment variable. Suspending makes it plain
 * text.
 */
export async function runPreRunCommands(
  script: string | undefined,
  options: PreRunOptions = {}
): Promise<boolean> {
  if (!script?.trim()) return false

  const directory = options.scriptDir ?? mkdtempSync(join(tmpdir(), 'terraform-pre-run-'))
  const path = join(directory, 'TERRAFORM_PRE_RUN.sh')
  writeFileSync(path, script)

  startGroup('Executing TERRAFORM_PRE_RUN')
  info('Running the setup commands given in the TERRAFORM_PRE_RUN environment variable')

  try {
    const exitCode = await withWorkflowCommandsStopped(() =>
      exec(options.shell ?? 'bash', ['-xeo', 'pipefail', path], { ignoreReturnCode: true })
    )

    if (exitCode !== 0) {
      throw new PreRunError(`TERRAFORM_PRE_RUN failed with exit code ${exitCode}`)
    }
  } finally {
    endGroup()
  }

  return true
}
