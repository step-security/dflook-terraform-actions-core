import { readFileSync, existsSync } from 'fs'

/**
 * Talking to the GitHub API.
 *
 * Only what the plan comment needs: find the pull request this run relates to,
 * read the comments on it, and add or edit one.
 *
 * The token here can write to the repository, so where a URL comes from matters.
 * Anything derived from event payload is checked against the expected API host
 * before it is requested, because some events carry attacker-influenced content.
 */

export class GitHubError extends Error {}

/** Raised for conditions that should be reported as a workflow error. */
export class WorkflowError extends Error {}

export interface GitHubComment {
  url: string
  issue_url: string
  node_id?: string
  body: string
  user?: { login?: string }
}

export interface PullRequest {
  url: string
  issue_url: string
  merge_commit_sha?: string
}

export interface GitHubClientOptions {
  token: string
  apiUrl?: string
  graphqlUrl?: string
  fetchImpl?: typeof fetch
}

const REQUEST_TIMEOUT_MS = 30_000

export class GitHubClient {
  private readonly token: string

  readonly apiUrl: string

  private readonly graphqlUrl: string

  private readonly fetchImpl: typeof fetch

  private cachedUser: string | undefined

  constructor(options: GitHubClientOptions) {
    this.token = options.token
    this.apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '')
    this.graphqlUrl = options.graphqlUrl ?? `${this.apiUrl}/graphql`
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private headers(): Record<string, string> {
    return {
      authorization: `token ${this.token}`,
      accept: 'application/vnd.github.v3+json',
      'content-type': 'application/json',
      'user-agent': 'step-security/dflook-terraform-actions',
    }
  }

  /**
   * Rejects a URL that is not on the expected API host.
   *
   * A pull request URL can arrive from event payload that a third party
   * influenced, and requesting it would send the token wherever it points.
   */
  assertOwnApi(url: string): void {
    if (!url.startsWith(`${this.apiUrl}/`)) {
      throw new WorkflowError(
        `Refusing to request ${url}, which is not on the expected GitHub API host (${this.apiUrl})`
      )
    }
  }

  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const absolute = url.startsWith('http') ? url : `${this.apiUrl}${url}`
    this.assertOwnApi(absolute)

    const response = await this.fetchImpl(absolute, {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      throw new GitHubError(`${init.method ?? 'GET'} ${absolute} returned ${response.status}`)
    }

    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  /** Follows `Link` headers so a long comment thread is read in full. */
  async paged<T>(url: string): Promise<T[]> {
    const items: T[] = []
    let next: string | undefined = url.startsWith('http')
      ? url
      : `${this.apiUrl}${url}${url.includes('?') ? '&' : '?'}per_page=100`

    while (next) {
      this.assertOwnApi(next)
      const response = await this.fetchImpl(next, {
        headers: this.headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new GitHubError(`GET ${next} returned ${response.status}`)
      }

      items.push(...((await response.json()) as T[]))
      next = nextLink(response.headers.get('link'))
    }

    return items
  }

  /**
   * The login the token acts as, used to find comments we wrote.
   *
   * GraphQL first: not every token works with it, but there is no REST endpoint
   * that returns the login for a GitHub App token. Falling back to `/user`
   * covers fine-grained personal access tokens.
   */
  async currentUser(): Promise<string> {
    if (this.cachedUser) return this.cachedUser

    this.cachedUser =
      (await this.viewerFromGraphql()) ?? (await this.loginFromRest()) ?? 'github-actions[bot]'
    return this.cachedUser
  }

  private async viewerFromGraphql(): Promise<string | undefined> {
    try {
      const response = await this.fetchImpl(this.graphqlUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ query: 'query { viewer { login } }' }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) return undefined
      const body = (await response.json()) as { data?: { viewer?: { login?: string } } }
      return body.data?.viewer?.login
    } catch {
      return undefined
    }
  }

  private async loginFromRest(): Promise<string | undefined> {
    try {
      const user = await this.request<{ login?: string }>('/user')
      return user.login
    } catch {
      return undefined
    }
  }

  /**
   * Collapses a comment in the GitHub interface.
   *
   * Best effort, deliberately. This is cosmetic: it stops a long-running pull
   * request accumulating expanded outdated plans. What actually makes a
   * superseded comment stop counting is the `closed` header set on it over REST,
   * so failing here changes nothing about which plan can approve an apply.
   *
   * Only reachable through GraphQL, which not every token can use, hence
   * swallowing the failure rather than reporting it.
   */
  async minimizeComment(nodeId: string | undefined, classifier = 'OUTDATED'): Promise<boolean> {
    if (!nodeId) return false

    try {
      const response = await this.fetchImpl(this.graphqlUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          query:
            'mutation($input: MinimizeCommentInput!) { minimizeComment(input: $input) { clientMutationId } }',
          variables: { input: { subjectId: nodeId, classifier } },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })

      if (!response.ok) return false

      // GraphQL reports errors in the body with a 200, so an ok status alone is
      // not success.
      const body = (await response.json()) as { errors?: unknown[] }
      return !body.errors?.length
    } catch {
      return false
    }
  }

  async getPullRequest(url: string): Promise<PullRequest> {
    return this.request<PullRequest>(url)
  }

  async listComments(issueUrl: string): Promise<GitHubComment[]> {
    return this.paged<GitHubComment>(`${issueUrl}/comments`)
  }

  async createComment(issueUrl: string, body: string): Promise<GitHubComment> {
    return this.request<GitHubComment>(`${issueUrl}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    })
  }

  async updateComment(commentUrl: string, body: string): Promise<GitHubComment> {
    return this.request<GitHubComment>(commentUrl, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    })
  }
}

/** Extracts the `rel="next"` URL from a Link header. */
export function nextLink(header: string | null): string | undefined {
  if (!header) return undefined

  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim())
    if (match) return match[1]
  }
  return undefined
}

export interface EventContext {
  eventName: string
  eventPath?: string
  repository?: string
  sha?: string
  ref?: string
  refType?: string
  apiUrl: string
}

/** Events that relate to a pull request without needing a lookup. */
const PR_EVENTS = [
  'pull_request',
  'pull_request_review_comment',
  'pull_request_target',
  'pull_request_review',
]

/**
 * Finds the pull request this run relates to.
 *
 * Which events can be resolved is part of the action's contract: an apply
 * awaiting comment approval can only run where a pull request can be found.
 */
export async function findPullRequest(
  client: GitHubClient,
  context: EventContext
): Promise<string> {
  const event = readEvent(context.eventPath)

  if (PR_EVENTS.includes(context.eventName)) {
    if (event) {
      const url = (event as { pull_request?: { url?: string } }).pull_request?.url
      if (url) {
        client.assertOwnApi(url)
        return url
      }
    }
    return fromRef(context)
  }

  if (context.eventName === 'issue_comment') {
    if (event) {
      const issue = (event as { issue?: { pull_request?: { url?: string } } }).issue
      if (!issue?.pull_request) {
        throw new WorkflowError(
          'This comment is not for a PR. Add a filter of `if: github.event.issue.pull_request`'
        )
      }
      const url = issue.pull_request.url
      if (url) {
        client.assertOwnApi(url)
        return url
      }
    }
    return fromRef(context)
  }

  if (context.eventName === 'repository_dispatch') {
    if (!event) throw payloadUnavailable(context)

    const payload = (event as { client_payload?: { pull_request?: { url?: unknown } } })
      .client_payload
    const url = payload?.pull_request?.url
    if (typeof url !== 'string') {
      throw new WorkflowError(
        'The repository_dispatch event must have a pull_request object with a url in the client_payload'
      )
    }

    // This URL came from whoever raised the dispatch, so it is checked before
    // the token is sent to it.
    client.assertOwnApi(url)
    return url
  }

  if (context.eventName === 'push') {
    if (!context.repository || !context.sha) throw payloadUnavailable(context)

    const pulls = await client.paged<PullRequest>(
      `/repos/${context.repository}/pulls?state=all`
    )
    const merged = pulls.find((pull) => pull.merge_commit_sha === context.sha)
    if (merged) return merged.url

    throw new WorkflowError(
      `No PR found in ${context.repository} for commit ${context.sha} (was it pushed directly to the target branch?)`
    )
  }

  throw new WorkflowError(`The ${context.eventName} event doesn't relate to a Pull Request.`)
}

function readEvent(eventPath: string | undefined): unknown {
  if (!eventPath || !existsSync(eventPath)) return undefined
  try {
    return JSON.parse(readFileSync(eventPath, 'utf8'))
  } catch {
    return undefined
  }
}

/** Recovers the pull request number from the ref when no payload is available. */
function fromRef(context: EventContext): string {
  if (context.refType === 'branch') {
    const match = /refs\/pull\/(\d+)\//.exec(context.ref ?? '')
    if (match && context.repository) {
      return `${context.apiUrl}/repos/${context.repository}/pulls/${match[1]}`
    }
  }
  throw payloadUnavailable(context)
}

function payloadUnavailable(context: EventContext): WorkflowError {
  return new WorkflowError(
    `Event payload is not available at the GITHUB_EVENT_PATH ${String(context.eventPath)}. ` +
      `This is required when run by ${context.eventName} events. The environment has not been set up ` +
      'properly by the actions runner. This can happen when the runner is running in a container'
  )
}
