import * as core from '@actions/core'

/**
 * Publishing Terraform outputs as step outputs.
 *
 * Every root module output becomes a step output of the same name, and any
 * marked `sensitive` is registered as a mask first so it is redacted wherever it
 * appears in the log afterwards. The masking is the reason ordering matters
 * here: registering it after publishing would leave the value visible in the
 * lines already written.
 */

export interface TerraformOutput {
  /** A string for a primitive, or a structure for a complex type. */
  type: unknown
  value: unknown
  sensitive?: boolean
}

export type TerraformOutputs = Record<string, TerraformOutput>

export class OutputParseError extends Error {}

/**
 * Parses `terraform output -json`, tolerating noise before the JSON.
 *
 * Terraform sometimes writes progress or warning lines to stdout ahead of the
 * document, so anything before the first line starting with `{` is discarded
 * rather than treated as a parse failure.
 */
export function parseOutputs(stdout: string): TerraformOutputs {
  const lines = stdout.split('\n')
  while (lines.length > 0 && !lines[0].startsWith('{')) lines.shift()

  if (lines.length === 0) {
    throw new OutputParseError('No JSON found in the output')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(lines.join('\n'))
  } catch (error) {
    throw new OutputParseError(
      `Unable to parse outputs: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OutputParseError('Unable to parse outputs')
  }

  return parsed as TerraformOutputs
}

/** A step output to publish, or a value to mask. */
export type OutputCommand =
  | { kind: 'output'; name: string; value: string }
  | { kind: 'mask'; value: string }

/**
 * Works out what to publish for each Terraform output.
 *
 * Kept separate from issuing the commands so the decisions are directly
 * testable — in particular that a sensitive value is always masked, whatever its
 * type.
 */
export function outputCommands(outputs: TerraformOutputs): OutputCommand[] {
  const commands: OutputCommand[] = []

  for (const [name, output] of Object.entries(outputs)) {
    if (typeof output.type === 'string') {
      // A primitive.
      if (output.sensitive === true) {
        commands.push({ kind: 'mask', value: String(output.value) })
      }

      if (output.type === 'string' || output.type === 'number') {
        commands.push({ kind: 'output', name, value: String(output.value) })
      } else if (output.type === 'bool') {
        commands.push({ kind: 'output', name, value: JSON.stringify(output.value) })
      }
      // Any other primitive is deliberately not published, matching upstream.
      continue
    }

    // A complex type, published as compact JSON.
    const value = JSON.stringify(output.value)
    if (output.sensitive === true) {
      commands.push({ kind: 'mask', value })
    }
    commands.push({ kind: 'output', name, value })
  }

  return commands
}

/** Flattens the outputs to plain name/value pairs for the JSON artifact. */
export function flattenOutputs(outputs: TerraformOutputs): Record<string, unknown> {
  const flattened: Record<string, unknown> = {}
  for (const name of Object.keys(outputs).sort()) {
    flattened[name] = outputs[name].value
  }
  return flattened
}

/**
 * Publishes the outputs, masking sensitive values first.
 *
 * Masks are issued ahead of the values they cover, so a sensitive value cannot
 * appear unredacted in a line written before its mask was registered.
 */
export function publishOutputs(outputs: TerraformOutputs): void {
  const commands = outputCommands(outputs)

  for (const command of commands) {
    if (command.kind === 'mask') core.setSecret(command.value)
  }
  for (const command of commands) {
    if (command.kind === 'output') core.setOutput(command.name, command.value)
  }
}
