import { randomBytes } from 'crypto'
import * as core from '@actions/core'

/**
 * Workflow command plumbing.
 *
 * Mostly a thin layer over @actions/core, except for the stop/resume pair, which
 * has no equivalent there and matters for safety rather than convenience.
 */

let stopToken: string | undefined

export function info(message: string): void {
  core.info(message)
}

export function debug(message: string): void {
  core.debug(message)
}

export function warning(message: string): void {
  core.warning(message)
}

export function error(message: string, file?: string): void {
  core.error(message, file ? { file } : undefined)
}

export function startGroup(title: string): void {
  core.startGroup(title)
}

export function endGroup(): void {
  core.endGroup()
}

/**
 * Stops the runner interpreting workflow commands until resumed.
 *
 * Needed whenever output we do not control is echoed to stdout. Without it, a
 * Terraform resource name or a user-supplied script could print
 * `::set-output::` or `::add-mask::` and have the runner act on it — output
 * becoming instruction. Everything between the two calls is treated as plain
 * text.
 */
export function stopWorkflowCommands(): void {
  if (stopToken) {
    throw new Error('Workflow commands are already stopped')
  }

  // Unguessable, so untrusted output cannot resume interpretation itself.
  stopToken = `dflook-core-${randomBytes(16).toString('hex')}`
  process.stdout.write(`::stop-commands::${stopToken}\n`)
}

export function resumeWorkflowCommands(): void {
  if (!stopToken) {
    throw new Error('Workflow commands are not stopped')
  }

  process.stdout.write(`::${stopToken}::\n`)
  stopToken = undefined
}

/** Runs a function with workflow command interpretation suspended. */
export async function withWorkflowCommandsStopped<T>(action: () => Promise<T>): Promise<T> {
  stopWorkflowCommands()
  try {
    return await action()
  } finally {
    resumeWorkflowCommands()
  }
}

/** True when commands are currently suspended. Exposed for tests. */
export function commandsStopped(): boolean {
  return stopToken !== undefined
}
