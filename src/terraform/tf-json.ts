/**
 * Reading the facts we need out of a module written in JSON syntax.
 *
 * Terraform accepts `.tf.json` (and OpenTofu `.tofu.json`) as an alternative to
 * HCL, and a configuration may mix the two. The same four facts are needed as
 * from HCL: the `required_version` constraint, the backend type, the backend
 * configuration, and which variables are marked sensitive.
 *
 * The JSON encoding is not a straight translation of HCL. Because JSON objects
 * cannot repeat a key, every construct that may appear more than once can be
 * written either as a single object or as an array of them, and both forms mean
 * the same thing. Each level nests independently, so a backend can arrive as
 * any of:
 *
 * ```json
 * {"terraform": {"backend": {"s3": {...}}}}
 * {"terraform": [{"backend": [{"s3": [{...}]}]}]}
 * ```
 *
 * Every reader here therefore normalises through `toBlockList` before looking
 * inside.
 */

export interface JsonBackend {
  /** Backend label, or `cloud` for a cloud block. */
  readonly type: string
  /** The block body, with any `workspaces` normalised to a list. */
  readonly config: Record<string, unknown>
}

/** What a single JSON file contributes to a module. */
export interface JsonModuleFacts {
  readonly requiredVersion?: string
  readonly backend?: JsonBackend
  /** Names of variables declared sensitive. May repeat if the file does. */
  readonly sensitiveVariables: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalises a construct to the list of blocks it represents.
 *
 * An object is a single block, an array is already a list, and anything else
 * contributes nothing. That last case is what makes a stray string harmless
 * rather than fatal.
 */
export function toBlockList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (isRecord(value)) return [value]
  return []
}

/**
 * Asserts that a value taken from a block list is a block.
 *
 * Throwing is deliberate. A file whose structure is wrong is not partially
 * read: the caller abandons the whole file, exactly as it does for HCL that
 * will not parse, so a malformed file never contributes half its facts.
 */
function asBlock(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`Expected a JSON object in a block, found ${Array.isArray(value) ? 'an array' : typeof value}`)
  }
  return value
}

/** The `required_version` constraint, from the first terraform block declaring one. */
export function getRequiredVersion(body: Record<string, unknown>): string | undefined {
  for (const block of toBlockList(body.terraform ?? [])) {
    const terraformBlock = asBlock(block)
    if ('required_version' in terraformBlock) {
      return String(terraformBlock.required_version)
    }
  }
  return undefined
}

/**
 * The backend the module declares.
 *
 * A `cloud` block takes precedence over a `backend` block in the same terraform
 * block, and the first terraform block to declare either wins.
 *
 * A `backend` block with no label at all ends the search rather than skipping
 * to the next candidate, which is what an empty `"backend": {}` does.
 */
export function getBackend(body: Record<string, unknown>): JsonBackend | undefined {
  for (const block of toBlockList(body.terraform ?? {})) {
    const terraformBlock = asBlock(block)

    for (const cloud of toBlockList(terraformBlock.cloud ?? [])) {
      const config = { ...asBlock(cloud) }
      if ('workspaces' in config) config.workspaces = toBlockList(config.workspaces)
      return { type: 'cloud', config }
    }

    for (const backend of toBlockList(terraformBlock.backend ?? [])) {
      const backendBlock = asBlock(backend)
      const type = Object.keys(backendBlock)[0]
      if (type === undefined) return undefined

      const config: Record<string, unknown> = {}
      for (const part of toBlockList(backendBlock[type])) {
        Object.assign(config, asBlock(part))
      }
      if ('workspaces' in config) config.workspaces = toBlockList(config.workspaces)

      return { type, config }
    }
  }

  return undefined
}

/**
 * Names of variables declared sensitive.
 *
 * Only a literal `true` or the string `"true"` counts. Notably `1` does not:
 * Terraform would reject it, and treating it as sensitive here while the real
 * tool does not would mask values that in fact appear in plan output.
 */
export function getSensitiveVariables(body: Record<string, unknown>): string[] {
  const names: string[] = []

  for (const block of toBlockList(body.variable ?? [])) {
    const variableBlock = asBlock(block)

    for (const [name, declaration] of Object.entries(variableBlock)) {
      for (const part of toBlockList(declaration)) {
        const config = asBlock(part)
        if (config.sensitive === true || config.sensitive === 'true') {
          names.push(name)
        }
      }
    }
  }

  return names
}

/**
 * Reads the facts out of the parsed body of a JSON module file.
 *
 * @throws if the document is not an object, or a construct that should be a
 * block is not. The caller drops the file in that case.
 */
export function readJsonModule(body: unknown): JsonModuleFacts {
  const document = asBlock(body)

  return {
    requiredVersion: getRequiredVersion(document),
    backend: getBackend(document),
    sensitiveVariables: getSensitiveVariables(document),
  }
}

/**
 * Parses the text of a JSON module file.
 *
 * @throws if the text is not valid JSON, or does not have the expected shape.
 */
export function parseJsonModule(text: string): JsonModuleFacts {
  return readJsonModule(JSON.parse(text))
}