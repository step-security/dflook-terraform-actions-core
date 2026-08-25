import { Version } from '../version/version'

/**
 * Discovering which releases exist.
 *
 * Terraform and OpenTofu publish through completely different channels:
 * HashiCorp exposes a directory listing on releases.hashicorp.com, while
 * OpenTofu publishes GitHub releases. Both are reduced to a list of versions
 * here so selection can treat them uniformly.
 */

const TERRAFORM_INDEX = 'https://releases.hashicorp.com/terraform/'
const OPENTOFU_RELEASES = 'https://api.github.com/repos/opentofu/opentofu/releases'

const REQUEST_TIMEOUT_MS = 60_000
const PAGE_SIZE = 100

/** Matches the version segment of each link in the release index. */
const INDEX_VERSION = /\/(\d+\.\d+\.\d+(?:-[\d\w-]+)?)/g

export class ReleaseLookupError extends Error {}

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'step-security-maintained-actions', ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new ReleaseLookupError(`GET ${url} returned ${response.status}`)
  }
  return response
}

/**
 * Every published Terraform version.
 *
 * Read from the release index rather than a JSON API because HashiCorp does not
 * publish one; the index is the authoritative list of what exists.
 */
export async function getTerraformVersions(): Promise<Version[]> {
  const body = await (await get(TERRAFORM_INDEX)).text()

  const versions: Version[] = []
  const seen = new Set<string>()

  for (const match of body.matchAll(INDEX_VERSION)) {
    const text = match[1]
    if (seen.has(text)) continue
    seen.add(text)

    try {
      versions.push(new Version(text, 'Terraform'))
    } catch {
      // A link that is not a version; the index contains other entries too.
    }
  }

  if (!versions.length) {
    throw new ReleaseLookupError('No Terraform versions found in the release index')
  }
  return versions
}

/**
 * Every published OpenTofu version.
 *
 * The releases endpoint is paged, and a token is used when one is available
 * purely to avoid the unauthenticated rate limit — the data itself is public.
 */
export async function getOpenTofuVersions(token?: string): Promise<Version[]> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
  if (token) headers.authorization = `Bearer ${token}`

  const versions: Version[] = []

  for (let page = 1; ; page++) {
    const response = await get(`${OPENTOFU_RELEASES}?per_page=${PAGE_SIZE}&page=${page}`, headers)
    const releases = (await response.json()) as Array<{ tag_name?: string }>

    if (!Array.isArray(releases) || releases.length === 0) break

    for (const release of releases) {
      const tag = release.tag_name?.replace(/^v/, '')
      if (!tag) continue
      try {
        versions.push(new Version(tag, 'OpenTofu'))
      } catch {
        // Releases are occasionally tagged with something that is not a version.
      }
    }

    if (releases.length < PAGE_SIZE) break
  }

  return versions
}
