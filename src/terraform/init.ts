import { existsSync, rmSync } from 'fs'
import { relative, resolve } from 'path'
import * as core from '@actions/core'
import { runTool, splitList } from './exec.js'

/**
 * Initializing a backend and selecting a workspace.
 *
 * Both steps are more forgiving than they look, and deliberately so. `init` is
 * allowed to fail when the reason is a workspace that does not exist yet,
 * because `workspace select` reports that far more clearly than `init` does.
 * `workspace select` in turn tolerates backends that have no selectable
 * workspaces at all. Tightening either one turns a clear error message into a
 * confusing one.
 */

export class InitError extends Error {}

export interface BackendConfigInputs {
  /** `key=value` pairs, one per line. */
  backendConfig?: string
  /** Paths to backend config files, relative to the workspace, one per line. */
  backendConfigFile?: string
}

/**
 * Builds the `-backend-config` arguments.
 *
 * File paths are given relative to the workspace but consumed relative to the
 * module, since `init` runs with the module as its working directory.
 */
export function backendConfigArgs(
  inputs: BackendConfigInputs,
  paths: { modulePath: string; workspaceRoot: string }
): string[] {
  const args: string[] = []

  for (const file of splitList(inputs.backendConfigFile)) {
    const absolute = resolve(paths.workspaceRoot, file)
    if (!existsSync(absolute)) {
      throw new InitError(`Path does not exist: "${file}"`)
    }
    args.push(`-backend-config=${relative(paths.modulePath, absolute)}`)
  }

  for (const config of splitList(inputs.backendConfig)) {
    args.push(`-backend-config=${config}`)
  }

  return args
}

/**
 * Errors from `init` that mean "that workspace isn't there", which is not fatal
 * on its own — selecting the workspace is what decides that.
 */
const WORKSPACE_MISSING = [
  /No existing workspaces\./,
  /Failed to select workspace/,
  /Currently selected workspace.*does not exist/,
]

export interface InitOptions {
  binary: string
  modulePath: string
  workspace: string
  backendConfigArgs: string[]
  /** Where Terraform keeps its working data. Cleared first, so a run starts clean. */
  dataDir: string
  env?: NodeJS.ProcessEnv
  /** Backend type from the configuration, which changes how workspaces behave. */
  backendType?: string
}

export interface InitResult {
  /**
   * Workspace to set as `TF_WORKSPACE` for later commands.
   *
   * Only set for backends where `workspace select` does not work but the
   * workspace still has to be chosen.
   */
  tfWorkspace?: string
}

/**
 * Initializes the backend, then selects the workspace.
 *
 * The data directory is removed first. Terraform caches the resolved backend
 * there, so a stale one from an earlier step in the same job would be reused in
 * preference to the configuration being initialized now.
 */
export async function initBackendWorkspace(options: InitOptions): Promise<InitResult> {
  core.startGroup('Initializing Terraform')
  try {
    rmSync(options.dataDir, { recursive: true, force: true })

    const result = await runTool(
      options.binary,
      ['init', '-input=false', ...options.backendConfigArgs],
      {
        cwd: options.modulePath,
        // TF_WORKSPACE makes init prepare the backend for this workspace. It is
        // set here only, not exported, so a failure to select it does not leak
        // into later commands.
        env: { ...(options.env ?? process.env), TF_WORKSPACE: options.workspace },
        silent: false,
      }
    )

    if (result.exitCode === 0) {
      if (result.stderr.trim()) core.info(result.stderr.trimEnd())
    } else if (WORKSPACE_MISSING.some((pattern) => pattern.test(result.stderr))) {
      // Not fatal: selecting the workspace next reports this properly.
      if (result.stderr.trim()) core.info(result.stderr.trimEnd())
    } else {
      if (result.stderr.trim()) core.error(result.stderr.trimEnd())
      throw new InitError(`Terraform init failed with exit code ${result.exitCode}`)
    }
  } finally {
    core.endGroup()
  }

  return selectWorkspace(options)
}

/**
 * Selects the workspace, tolerating backends that do not support selection.
 *
 * A remote backend takes its workspace from the configuration, and a `cloud`
 * block may be only partially configured here — in both cases asking for a
 * workspace by name fails without anything being wrong.
 */
export async function selectWorkspace(options: InitOptions): Promise<InitResult> {
  const result = await runTool(options.binary, ['workspace', 'select', options.workspace], {
    cwd: options.modulePath,
    env: options.env,
    silent: true,
  })

  // Terraform writes to either stream here depending on version.
  const output = `${result.stdout}${result.stderr}`
  let exitCode = result.exitCode
  let tfWorkspace: string | undefined

  if (output.trim()) {
    core.startGroup('Selecting workspace')
    try {
      if (
        exitCode !== 0 &&
        /workspaces not supported/.test(output) &&
        options.workspace === 'default'
      ) {
        core.info(
          'The full name of a remote workspace is set by the Terraform configuration, selecting a different one is not supported'
        )
        exitCode = 0
      } else if (exitCode !== 0 && options.backendType === 'cloud') {
        // Selection does not work against a partial cloud config. Naming the
        // workspace in the environment is the only way to choose it, and whether
        // it exists only becomes apparent when a command runs.
        core.info(`Using the ${options.workspace} workspace`)
        tfWorkspace = options.workspace
        exitCode = 0
      } else {
        core.info(output.trimEnd())
      }
    } finally {
      core.endGroup()
    }
  }

  if (exitCode !== 0) {
    throw new InitError(`Selecting the ${options.workspace} workspace failed`)
  }

  return { tfWorkspace }
}
