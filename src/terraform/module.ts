import { readFileSync, readdirSync, statSync } from 'fs'
import { extname, join } from 'path'
import { Constraint, parseConstraints } from '../version/constraint.js'
import { JsonBackend, JsonModuleFacts, parseJsonModule } from './tf-json.js'

/**
 * Reading the few facts we need out of a Terraform module.
 *
 * Only four things are ever needed: the `required_version` constraint, the
 * backend type, the remote/cloud backend configuration, and which variables are
 * marked sensitive. A full HCL parser is not required for that, so this reads
 * the specific constructs instead.
 *
 * Comments are stripped before anything is matched. That matters more than it
 * sounds: a commented-out backend block is extremely common while migrating
 * state, and a naive match would pick it up and choose the wrong backend.
 *
 * A module may also be written in JSON. Those files cannot be matched as text,
 * so they are parsed separately and carried alongside the HCL body as facts.
 * HCL is consulted first for each fact and JSON answers only when HCL is
 * silent, except for sensitive variables, where the two are combined: missing
 * one there would unmask a value in a published comment.
 */

export interface TerraformModule {
  /** Concatenated source of every HCL file in the module, comments removed. */
  readonly body: string
  /** Files that were read, in the order they were merged. */
  readonly files: readonly string[]
  /** Facts from each JSON file that was read, in the same order. */
  readonly json: readonly JsonModuleFacts[]
}

/**
 * Removes comments while preserving string literals.
 *
 * A `#` inside a quoted string is not a comment, so the scan tracks whether it
 * is inside quotes rather than matching line-wise.
 */
export function stripComments(source: string): string {
  let output = ''
  let index = 0
  let inString: '"' | "'" | undefined
  let inHeredoc: string | undefined

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (inHeredoc) {
      // Heredoc bodies are copied verbatim until the terminator on its own line.
      const lineEnd = source.indexOf('\n', index)
      const line = source.slice(index, lineEnd === -1 ? undefined : lineEnd)
      if (line.trim() === inHeredoc) inHeredoc = undefined
      output += line + (lineEnd === -1 ? '' : '\n')
      index = lineEnd === -1 ? source.length : lineEnd + 1
      continue
    }

    if (inString) {
      output += char
      if (char === '\\') {
        output += next ?? ''
        index += 2
        continue
      }
      if (char === inString) inString = undefined
      index += 1
      continue
    }

    if (char === '"' || char === "'") {
      inString = char
      output += char
      index += 1
      continue
    }

    const heredoc = /^<<-?([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(index))
    if (heredoc) {
      inHeredoc = heredoc[1]
      output += heredoc[0]
      index += heredoc[0].length
      continue
    }

    if (char === '#' || (char === '/' && next === '/')) {
      const lineEnd = source.indexOf('\n', index)
      if (lineEnd === -1) break
      output += '\n'
      index = lineEnd + 1
      continue
    }

    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2)
      index = close === -1 ? source.length : close + 2
      output += ' '
      continue
    }

    output += char
    index += 1
  }

  return output
}

/** Whether a file is a module file written in JSON rather than HCL. */
export function isJsonModuleFile(name: string): boolean {
  return name.endsWith('.tf.json') || name.endsWith('.tofu.json')
}

/**
 * The name a `.tf`/`.tofu` pair share, so one can override the other.
 *
 * JSON files are keyed separately from HCL ones: `main.tf` and `main.tf.json`
 * are both read, and neither replaces the other. Only `main.tofu.json` replaces
 * `main.tf.json`.
 */
function overrideKey(name: string): string {
  if (name.endsWith('.tf.json')) return `${name.slice(0, -'.tf.json'.length)}.json`
  if (name.endsWith('.tofu.json')) return `${name.slice(0, -'.tofu.json'.length)}.json`
  const extension = extname(name)
  return name.slice(0, name.length - extension.length)
}

/**
 * Files that make up the module.
 *
 * With OpenTofu selected, a `.tofu` file replaces the `.tf` file of the same
 * name — that is how a configuration provides tofu-specific overrides. The same
 * applies to `.tofu.json` over `.tf.json`.
 *
 * Without OpenTofu, `.tofu` and `.tofu.json` files are not read at all.
 */
export function filesInModule(path: string, openTofu = false): string[] {
  let entries: string[]
  try {
    entries = readdirSync(path).sort()
  } catch {
    return []
  }

  if (!openTofu) {
    return entries
      .filter((name) => extname(name) === '.tf' || name.endsWith('.tf.json'))
      .map((name) => join(path, name))
  }

  const chosen = new Map<string, string>()
  for (const name of entries) {
    const extension = extname(name)
    const key = overrideKey(name)

    if (extension === '.tf' && !chosen.has(key)) chosen.set(key, join(path, name))
    else if (extension === '.tofu') chosen.set(key, join(path, name))
    else if (name.endsWith('.tf.json') && !chosen.has(key)) chosen.set(key, join(path, name))
    else if (name.endsWith('.tofu.json')) chosen.set(key, join(path, name))
  }
  return [...chosen.values()]
}

/**
 * Reads and merges every file in the module.
 *
 * Files that cannot be read, and JSON files that do not parse or are shaped
 * wrongly, are skipped whole. A malformed file never contributes some of its
 * facts and not others, which would be worse than ignoring it: Terraform will
 * report the problem itself in due course.
 */
export function loadModule(path: string, openTofu = false): TerraformModule {
  const files: string[] = []
  const bodies: string[] = []
  const json: JsonModuleFacts[] = []

  for (const file of filesInModule(path, openTofu)) {
    try {
      if (!statSync(file).isFile()) continue
      const text = readFileSync(file, 'utf8')

      if (isJsonModuleFile(file)) {
        json.push(parseJsonModule(text))
      } else {
        bodies.push(stripComments(text))
      }

      files.push(file)
    } catch {
      // A file that cannot be read or parsed cannot contribute.
    }
  }

  return { body: bodies.join('\n'), files, json }
}

/** The `required_version` constraint expression, if the module declares one. */
export function getRequiredVersionExpression(module: TerraformModule): string | undefined {
  const match = /required_version\s*=\s*"([^"]+)"/.exec(module.body)
  if (match) return match[1]

  for (const file of module.json) {
    if (file.requiredVersion !== undefined) return file.requiredVersion
  }
  return undefined
}

/** The `required_version` constraint, parsed. Undefined when absent. */
export function getVersionConstraints(module: TerraformModule): Constraint[] | undefined {
  const expression = getRequiredVersionExpression(module)
  if (!expression) return undefined

  const constraints = parseConstraints(expression)
  return constraints.length ? constraints : undefined
}

/**
 * The backend the module uses.
 *
 * A `cloud` block counts as the `cloud` backend. With neither a backend block
 * nor a cloud block, Terraform defaults to local state.
 */
export function getBackendType(module: TerraformModule): string {
  const quoted = /backend\s*"([^"]+)"/.exec(module.body)
  if (quoted) return quoted[1]

  const bare = /backend\s+([A-Za-z0-9_-]+)\s*\{/.exec(module.body)
  if (bare) return bare[1].trim()

  if (/\bcloud\s*\{/.test(module.body)) return 'cloud'

  const declared = getJsonBackend(module)
  if (declared) return declared.type

  return 'local'
}

/** The backend declared by the first JSON file in the module to declare one. */
export function getJsonBackend(module: TerraformModule): JsonBackend | undefined {
  for (const file of module.json) {
    if (file.backend) return file.backend
  }
  return undefined
}

/**
 * Names of variables declared `sensitive = true`.
 *
 * Both `variable "name" {` and the unquoted `variable name {` are recognised —
 * Terraform accepts the latter and real configurations use it.
 */
export function getSensitiveVariables(module: TerraformModule): string[] {
  const names: string[] = []
  const blocks = module.body.matchAll(/variable\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_-]*))\s*\{/g)

  for (const block of blocks) {
    const name = block[1] ?? block[2]
    const start = (block.index ?? 0) + block[0].length

    // Scan to the matching brace so a nested block cannot leak into the next
    // variable's body.
    let depth = 1
    let index = start
    while (index < module.body.length && depth > 0) {
      if (module.body[index] === '{') depth += 1
      else if (module.body[index] === '}') depth -= 1
      index += 1
    }

    const body = module.body.slice(start, index)
    if (/sensitive\s*=\s*"?true"?/i.test(body)) names.push(name)
  }

  // Combined rather than used as a fallback. These names decide what gets
  // masked in a published comment, so a variable declared sensitive in either
  // syntax has to count, whatever the other syntax says.
  for (const file of module.json) {
    names.push(...file.sensitiveVariables)
  }

  return [...new Set(names)]
}
