import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { splitList } from '../terraform/exec.js'
import type { TerraformModule } from '../terraform/module.js'

/**
 * Assembling the backend configuration.
 *
 * This exists to identify *which state file* a plan belongs to, so a comment on
 * a pull request can be matched to the configuration it was produced from. It is
 * not used to configure anything.
 *
 * The config is built up the way Terraform builds it: the backend block in the
 * module, then any `backend_config_file`, then any `backend_config` values, each
 * layer overriding the last.
 *
 * Values are not filtered, including ones that look like credentials. The `pg`
 * backend is identified by its `conn_str`, which carries a password, so removing
 * it would stop comments matching for those users. Nothing here is published:
 * only a SHA-256 of the result reaches the comment.
 */

export type BackendConfig = Record<string, string>

/**
 * Extracts the body of the backend or cloud block.
 *
 * Comments are already stripped from `module.body`, which matters more than it
 * sounds: a commented-out backend block is common while migrating state, and
 * reading it would fingerprint the wrong backend.
 */
function backendBlockBody(body: string): string | undefined {
  const opening =
    /(?:backend\s*"[^"]+"|backend\s+[A-Za-z0-9_-]+|cloud)\s*\{/.exec(body)
  if (!opening) return undefined

  // Walk braces rather than matching to the first `}`, since nested blocks like
  // `workspaces { ... }` would otherwise cut the body short.
  let depth = 0
  const start = opening.index + opening[0].length
  for (let at = start - 1; at < body.length; at += 1) {
    if (body[at] === '{') depth += 1
    else if (body[at] === '}') {
      depth -= 1
      if (depth === 0) return body.slice(start, at)
    }
  }
  return body.slice(start)
}

/**
 * Reads `key = value` pairs from a block body.
 *
 * Nested blocks collapse to a single value holding their contents, which is what
 * the `remote` backend's `workspaces` block needs: it is fingerprinted as one
 * opaque string rather than being understood.
 */
function readAssignments(block: string): BackendConfig {
  const config: BackendConfig = {}

  const assignment = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*$/
  const nested = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\{/

  const lines = block.split('\n')
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]

    const block_ = nested.exec(line)
    if (block_) {
      // Gather the nested block's contents as one value.
      let depth = line.split('{').length - line.split('}').length
      const parts: string[] = []
      while (depth > 0 && at + 1 < lines.length) {
        at += 1
        const inner = lines[at]
        depth += inner.split('{').length - inner.split('}').length
        if (depth > 0) parts.push(inner.trim())
      }
      config[block_[1]] = parts.join(' ')
      continue
    }

    const match = assignment.exec(line)
    if (match) config[match[1]] = unquote(match[2])
  }

  return config
}

/** Removes surrounding quotes, leaving anything else as written. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** The backend type and the config written in the module. */
export function readModuleBackendConfig(module: TerraformModule): BackendConfig {
  const block = backendBlockBody(module.body)
  return block ? readAssignments(block) : {}
}

/** Reads `key = value` pairs from the backend config files. */
export function readBackendConfigFiles(
  backendConfigFile: string | undefined,
  workspaceRoot: string
): BackendConfig {
  const config: BackendConfig = {}

  for (const relative of splitList(backendConfigFile)) {
    const path = resolve(workspaceRoot, relative)
    if (!existsSync(path)) continue
    Object.assign(config, readAssignments(readFileSync(path, 'utf8')))
  }

  return config
}

/**
 * Reads the `backend_config` input.
 *
 * Entries are `key=value`. Only the first `=` separates, since a value may well
 * contain one.
 */
export function readBackendConfigInput(backendConfig: string | undefined): BackendConfig {
  const config: BackendConfig = {}

  for (const entry of splitList(backendConfig)) {
    const at = entry.indexOf('=')
    if (at <= 0) continue
    config[entry.slice(0, at)] = entry.slice(at + 1)
  }

  return config
}

export interface CompleteConfigInputs {
  module: TerraformModule
  backendConfig?: string
  backendConfigFile?: string
  workspaceRoot: string
}

/**
 * The complete backend config, in Terraform's own precedence order.
 *
 * Module block first, then config files, then the inline input, each overriding
 * the last.
 */
export function completeBackendConfig(inputs: CompleteConfigInputs): BackendConfig {
  return {
    ...readModuleBackendConfig(inputs.module),
    ...readBackendConfigFiles(inputs.backendConfigFile, inputs.workspaceRoot),
    ...readBackendConfigInput(inputs.backendConfig),
  }
}
