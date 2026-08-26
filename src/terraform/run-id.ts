/**
 * Recovering the remote run identifier.
 *
 * When the `remote` or `cloud` backend runs an operation remotely, Terraform
 * prints a link to it. The identifier in that link is the only handle a workflow
 * has on the run, so it is published as an output for anything that needs to
 * follow up — fetching the JSON plan from the API, or linking a human to it.
 *
 * It is scraped from output rather than requested, because Terraform does not
 * report it any other way.
 */

/**
 * Matches the run link Terraform prints.
 *
 * Applied per line rather than with a multiline flag over the whole output. The
 * pattern has a greedy `.*` before a required `/`, so letting it run across a
 * whole document would make the cost depend on the document length rather than
 * the line length.
 */
const RUN_LINK = /https:\/\/.*\/[^/]*\/runs\/(run-.*)$/

/**
 * Finds the first run id in the given output.
 *
 * Sources are searched in the order given, so a caller can prefer stdout and
 * fall back to stderr, which is where Terraform puts the link when the operation
 * failed.
 */
export function getRemoteRunId(...sources: (string | undefined)[]): string | undefined {
  for (const source of sources) {
    if (!source) continue

    for (const line of source.split('\n')) {
      // Cheap reject before the expensive pattern.
      if (!line.includes('/runs/run-')) continue

      const match = RUN_LINK.exec(line.trimEnd())
      if (match) return match[1]
    }
  }

  return undefined
}

/** True for the backends that execute remotely and therefore have a run id. */
export function isRemoteExecution(backendType: string | undefined): boolean {
  return backendType === 'remote' || backendType === 'cloud'
}
