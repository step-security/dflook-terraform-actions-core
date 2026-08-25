import { Constraint, applyConstraints } from './constraint'
import {
  fromAsdf,
  fromEnvironment,
  fromLocalState,
  fromRequiredVersion,
  fromTfenv,
  fromTfswitch,
} from './sources'
import { Version, latestFinalVersion } from './version'
import { TerraformModule, getBackendType } from '../terraform/module'
import { releaseArch } from '../terraform/platform'

/**
 * Choosing which version to run.
 *
 * Order matters more than any individual source. It runs from the most
 * authoritative statement of intent to the least:
 *
 *  1. the remote workspace, when the backend can tell us what it expects
 *  2. `required_version` in the configuration
 *  3. `.tfswitchrc`
 *  4. `.opentofu-version`, when OpenTofu is selected
 *  5. `.terraform-version`
 *  6. `.tool-versions`
 *  7. `TERRAFORM_VERSION` / `OPENTOFU_VERSION`
 *  8. the version that wrote the existing state
 *  9. the newest release
 *
 * The environment variable sitting seventh is deliberate and worth knowing: a
 * `required_version` in the configuration wins over it, because the
 * configuration states what the code needs while the variable states only what
 * the workflow would prefer.
 */

export interface ResolveInputs {
  /** Directory of the module being operated on. */
  modulePath: string
  /** Repository root, used to bound the `.tool-versions` search. */
  workspaceRoot: string
  /** Non-empty when the caller passed backend config key/values. */
  backendConfig?: string
  /** True when OpenTofu is being used. */
  openTofu?: boolean
}

export interface ResolveContext {
  module: TerraformModule
  /** Every version available across the selected products. */
  versions: Version[]
  env: Record<string, string | undefined>
  /**
   * Asks the remote workspace which version it expects. Supplied by the caller
   * so that resolution needs no network of its own.
   */
  remoteWorkspaceVersion?: () => Version | undefined
  /**
   * Reads the version that wrote existing remote state, when the backend
   * supports being inspected that way.
   */
  remoteStateVersion?: () => Version | undefined
  /** Constraints imposed by the backend in use. */
  backendConstraints?: () => Constraint[]
}

export interface Resolution {
  version: Version
  /** Human-readable account of why this version was chosen. */
  reason: string
}

/** Versions whose architecture support rules out earlier releases. */
const ARM64_SUPPORTED_FROM = '0.13.5'

/** Backend config as `key=value` pairs first became available here. */
const BACKEND_KEY_VALUE_FROM = '0.9.1'

export function resolveVersion(
  inputs: ResolveInputs,
  context: ResolveContext
): Resolution | undefined {
  const { modulePath, workspaceRoot, openTofu = false } = inputs
  const { module, env } = context
  let versions = context.versions

  const remote = context.remoteWorkspaceVersion?.()
  if (remote) {
    return { version: remote, reason: `the remote workspace is set to ${remote}` }
  }

  const required = fromRequiredVersion(module, versions)
  if (required) {
    return {
      version: required,
      reason: `it is the newest ${required.product} matching the required_version constraints`,
    }
  }

  const tfswitch = fromTfswitch(modulePath)
  if (tfswitch) {
    return { version: tfswitch, reason: 'it is specified in .tfswitchrc' }
  }

  if (openTofu) {
    const tofuFile = fromTfenv(modulePath, '.opentofu-version', versions)
    if (tofuFile) {
      return { version: tofuFile, reason: 'it is specified in .opentofu-version' }
    }
  }

  const tfenv = fromTfenv(modulePath, '.terraform-version', versions)
  if (tfenv) {
    return { version: tfenv, reason: 'it is specified in .terraform-version' }
  }

  const asdf = fromAsdf(modulePath, workspaceRoot, versions)
  if (asdf) {
    return { version: asdf, reason: 'it is specified in .tool-versions' }
  }

  const environment = fromEnvironment(env, versions)
  if (environment.version) {
    return {
      version: environment.version,
      reason: `it is the newest ${environment.version.product} matching ${environment.variable}`,
    }
  }

  // Passing backend config as key/value pairs requires a version that supports
  // the flag, so asking for it rules out anything older.
  if (inputs.backendConfig?.trim()) {
    versions = applyConstraints(versions, [new Constraint(`>=${BACKEND_KEY_VALUE_FROM}`)])
  }

  const backendConstraints = context.backendConstraints?.() ?? []
  if (backendConstraints.length) {
    versions = applyConstraints(versions, backendConstraints)
  }

  const backend = getBackendType(module)

  if (backend === 'local') {
    const local = fromLocalState(modulePath, openTofu)
    if (local) {
      return { version: local, reason: 'it wrote the existing local terraform.tfstate' }
    }
  }

  if (releaseArch() === 'arm64') {
    versions = applyConstraints(versions, [new Constraint(`>=${ARM64_SUPPORTED_FROM}`)])
  }

  // remote and cloud backends are asked directly, above; local state has already
  // been read. Anything else may have inspectable state.
  if (!['remote', 'cloud', 'local'].includes(backend)) {
    const remoteState = context.remoteStateVersion?.()
    if (remoteState) {
      return { version: remoteState, reason: 'it wrote the existing remote state' }
    }
  }

  const latest = latestFinalVersion(versions)
  if (!latest) return undefined

  return { version: latest, reason: 'no version was specified, so the newest release was used' }
}

/**
 * The candidate set for a run.
 *
 * With OpenTofu selected, Terraform is capped below 1.6.0 — the point at which
 * the projects diverged — and OpenTofu's own releases are added. Without it,
 * only Terraform is considered.
 */
export function candidateVersions(
  terraform: Version[],
  openTofu: Version[] | undefined
): Version[] {
  if (!openTofu) return terraform

  const capped = applyConstraints(terraform, [new Constraint('<1.6.0')])
  return [...capped, ...openTofu]
}
