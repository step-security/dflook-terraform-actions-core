import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Fetching a plan from Terraform Cloud.
 *
 * The remote and cloud backends run the plan on Terraform Cloud rather than on
 * the runner, so no plan file is produced locally. The JSON plan can still be
 * had, but only by asking the API for it using the run id scraped from the
 * output.
 *
 * This is the only part of the core that talks to something other than GitHub or
 * a release host, so it is deliberately narrow: one read, no writes.
 */

/** Default Terraform Cloud host, used when the configuration names none. */
export const DEFAULT_CLOUD_HOST = 'app.terraform.io'

export class CloudError extends Error {}

/**
 * Reads host tokens from a Terraform CLI config file.
 *
 * The format is a series of blocks:
 *
 * ```hcl
 * credentials "app.terraform.io" {
 *   token = "..."
 * }
 * ```
 *
 * Read line by line rather than with one pattern over the whole file. A single
 * global pattern spanning blocks has to rescan from every position when it fails
 * to match, which is quadratic in the file size. Scanning lines is linear and,
 * as it turns out, easier to follow.
 *
 * Not a general HCL parser. This file is written by `writeCredentials` from the
 * action's own inputs, or by `terraform login`, so its shape is known — and
 * pulling in a parser to read one nested attribute is not worth it.
 */
export function readCliCredentials(config: string): Record<string, string> {
  const hosts: Record<string, string> = {}

  const opening = /^\s*credentials\s+"([^"]{1,253})"\s*\{/
  const token = /^\s*token\s*=\s*"([^"]*)"/

  let host: string | undefined

  for (const line of config.split('\n')) {
    if (host === undefined) {
      const match = opening.exec(line)
      if (match) host = match[1]
      continue
    }

    // Inside a block: take the token, and stop at the closing brace.
    const value = token.exec(line)
    if (value) {
      hosts[host] = value[1]
      continue
    }

    if (line.includes('}')) host = undefined
  }

  return hosts
}

/**
 * Finds the token for a host.
 *
 * A missing or unreadable file is not an error. The JSON plan is a convenience
 * output, and failing the run because it could not be fetched would be worse
 * than not publishing it.
 */
export function getCliCredentials(
  hostname: string,
  configPath = join(homedir(), '.terraformrc')
): string | undefined {
  if (!existsSync(configPath)) return undefined

  try {
    return readCliCredentials(readFileSync(configPath, 'utf8'))[hostname]
  } catch {
    return undefined
  }
}

export interface CloudClientOptions {
  hostname?: string
  token: string
  fetchImpl?: typeof fetch
}

const REQUEST_TIMEOUT_MS = 30_000

export class TerraformCloudClient {
  private readonly hostname: string

  private readonly token: string

  private readonly fetchImpl: typeof fetch

  constructor(options: CloudClientOptions) {
    this.hostname = options.hostname || DEFAULT_CLOUD_HOST
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * Fetches the JSON plan for a run.
   *
   * Status codes are distinguished because the causes differ and so does the
   * advice: an expired token needs fixing, a rate limit needs waiting.
   */
  async getJsonPlan(runId: string): Promise<string> {
    const url = `https://${this.hostname}/api/v2/runs/${encodeURIComponent(runId)}/plan/json-output`

    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/vnd.api+json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (response.status === 401) {
      throw new CloudError('Terraform Cloud rejected the token as unauthorized')
    }
    if (response.status === 429) {
      throw new CloudError('Terraform Cloud rate limit reached')
    }
    if (!response.ok) {
      throw new CloudError(`Terraform Cloud returned ${response.status}`)
    }

    return response.text()
  }
}

export interface FetchJsonPlanOptions {
  runId: string
  /** Host from the backend configuration, if it named one. */
  hostname?: string
  /** Token from the backend configuration, if it carried one. */
  token?: string
  configPath?: string
  fetchImpl?: typeof fetch
}

/**
 * Fetches the JSON plan, or returns undefined with a reason.
 *
 * Never throws. The caller publishes an output when this succeeds and says
 * nothing when it does not, which is how upstream behaves — the plan itself has
 * already been produced, and this only affects one convenience output.
 */
export async function fetchCloudJsonPlan(
  options: FetchJsonPlanOptions
): Promise<{ plan: string } | { reason: string }> {
  const hostname = options.hostname || DEFAULT_CLOUD_HOST
  const token = options.token ?? getCliCredentials(hostname, options.configPath)

  if (!token) {
    return { reason: `No Terraform Cloud token available for ${hostname}` }
  }

  try {
    const client = new TerraformCloudClient({
      hostname,
      token,
      fetchImpl: options.fetchImpl,
    })
    return { plan: await client.getJsonPlan(options.runId) }
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) }
  }
}