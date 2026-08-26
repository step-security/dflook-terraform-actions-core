import { exec } from '@actions/exec'

/**
 * Running the Terraform binary.
 *
 * Terraform uses its exit code to carry meaning — `plan -detailed-exitcode`
 * returns 2 for "there are changes", which is a success as far as the tool is
 * concerned. So nothing here throws on a non-zero exit; the caller decides what
 * each code means.
 */

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  /** Directory to run in. Terraform is sensitive to this: it reads the module from cwd. */
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Suppresses live echoing. Output is captured either way. */
  silent?: boolean
}

/**
 * Runs the tool and captures both streams separately.
 *
 * They are kept apart rather than interleaved because the two are read for
 * different things: stdout is the plan, which gets published, while stderr
 * carries the errors that decide whether the run failed at all.
 */
export async function runTool(
  binary: string,
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> {
  let stdout = ''
  let stderr = ''

  const exitCode = await exec(binary, args, {
    cwd: options.cwd,
    env: options.env as Record<string, string> | undefined,
    ignoreReturnCode: true,
    silent: options.silent ?? true,
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString()
      },
      stderr: (data: Buffer) => {
        stderr += data.toString()
      },
    },
  })

  return { exitCode, stdout, stderr }
}

/**
 * Splits one of the newline-separated list inputs.
 *
 * Commas separate as well as newlines, and surrounding whitespace is
 * insignificant, matching how upstream reads these inputs. Empty entries are
 * dropped so a trailing newline in a YAML block scalar does not become an empty
 * argument.
 */
export function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}
