import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  GitHubClient,
  WorkflowError,
  findPullRequest,
  nextLink,
} from '../src/comment/github.js'

const API = 'https://api.github.com'

function client(routes: Record<string, unknown> = {}, apiUrl = API): GitHubClient {
  const fetchImpl = (async (url: string) => {
    const match = Object.entries(routes).find(([suffix]) => String(url).includes(suffix))
    if (!match) return { ok: false, status: 404, headers: new Headers() }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => match[1],
    }
  }) as unknown as typeof fetch

  return new GitHubClient({ token: 'secret-token', apiUrl, fetchImpl })
}

function eventFile(payload: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'event-')), 'event.json')
  writeFileSync(path, JSON.stringify(payload))
  return path
}

const BASE = { apiUrl: API, repository: 'o/r', eventName: 'pull_request' }

describe('finding the pull request', () => {
  it.each([
    'pull_request',
    'pull_request_review_comment',
    'pull_request_target',
    'pull_request_review',
  ])('reads it from a %s payload', async (eventName) => {
    const eventPath = eventFile({ pull_request: { url: `${API}/repos/o/r/pulls/7` } })

    await expect(
      findPullRequest(client(), { ...BASE, eventName, eventPath })
    ).resolves.toBe(`${API}/repos/o/r/pulls/7`)
  })

  it('reads it from an issue_comment on a pull request', async () => {
    const eventPath = eventFile({
      issue: { pull_request: { url: `${API}/repos/o/r/pulls/9` } },
    })

    await expect(
      findPullRequest(client(), { ...BASE, eventName: 'issue_comment', eventPath })
    ).resolves.toBe(`${API}/repos/o/r/pulls/9`)
  })

  it('explains how to filter an issue_comment that is not a pull request', async () => {
    const eventPath = eventFile({ issue: {} })

    await expect(
      findPullRequest(client(), { ...BASE, eventName: 'issue_comment', eventPath })
    ).rejects.toThrow(/github\.event\.issue\.pull_request/)
  })

  it('finds the pull request a push was merged from', async () => {
    const routes = {
      '/pulls': [
        { url: `${API}/repos/o/r/pulls/1`, merge_commit_sha: 'aaa' },
        { url: `${API}/repos/o/r/pulls/2`, merge_commit_sha: 'bbb' },
      ],
    }

    await expect(
      findPullRequest(client(routes), { ...BASE, eventName: 'push', sha: 'bbb' })
    ).resolves.toBe(`${API}/repos/o/r/pulls/2`)
  })

  it('says so when a push matches no pull request', async () => {
    await expect(
      findPullRequest(client({ '/pulls': [] }), { ...BASE, eventName: 'push', sha: 'ccc' })
    ).rejects.toThrow(/was it pushed directly to the target branch/)
  })

  it('rejects an event that cannot relate to a pull request', async () => {
    await expect(
      findPullRequest(client(), { ...BASE, eventName: 'schedule' })
    ).rejects.toThrow(/doesn't relate to a Pull Request/)
  })

  /** The runner sometimes provides no payload, but the ref still names the PR. */
  it('falls back to the ref when there is no payload', async () => {
    await expect(
      findPullRequest(client(), {
        ...BASE,
        eventName: 'pull_request',
        eventPath: '/definitely/absent',
        refType: 'branch',
        ref: 'refs/pull/42/merge',
      })
    ).resolves.toBe(`${API}/repos/o/r/pulls/42`)
  })

  it('reports a missing payload it cannot work around', async () => {
    await expect(
      findPullRequest(client(), {
        ...BASE,
        eventName: 'pull_request',
        eventPath: '/definitely/absent',
      })
    ).rejects.toThrow(/Event payload is not available/)
  })
})

/**
 * The token can write to the repository, and a repository_dispatch payload is
 * supplied by whoever raised the dispatch. A URL from there must not be able to
 * point the token at another host.
 */
describe('refusing a url off the expected api host', () => {
  it('rejects a repository_dispatch url on another host', async () => {
    const eventPath = eventFile({
      client_payload: { pull_request: { url: 'https://evil.example/repos/o/r/pulls/1' } },
    })

    await expect(
      findPullRequest(client(), { ...BASE, eventName: 'repository_dispatch', eventPath })
    ).rejects.toThrow(WorkflowError)
  })

  it('accepts a repository_dispatch url on the expected host', async () => {
    const eventPath = eventFile({
      client_payload: { pull_request: { url: `${API}/repos/o/r/pulls/3` } },
    })

    await expect(
      findPullRequest(client(), { ...BASE, eventName: 'repository_dispatch', eventPath })
    ).resolves.toBe(`${API}/repos/o/r/pulls/3`)
  })

  it('rejects a host that merely starts the same', async () => {
    const eventPath = eventFile({
      client_payload: { pull_request: { url: 'https://api.github.com.evil.example/x' } },
    })

    await expect(
      findPullRequest(client(), { ...BASE, eventName: 'repository_dispatch', eventPath })
    ).rejects.toThrow(WorkflowError)
  })

  it('requires a pull_request url in the dispatch payload', async () => {
    const eventPath = eventFile({ client_payload: {} })

    await expect(
      findPullRequest(client(), { ...BASE, eventName: 'repository_dispatch', eventPath })
    ).rejects.toThrow(/must have a pull_request object/)
  })

  /** GitHub Enterprise has its own API host, which must be honoured. */
  it('accepts an enterprise api host', async () => {
    const enterprise = 'https://github.example.com/api/v3'
    const eventPath = eventFile({
      client_payload: { pull_request: { url: `${enterprise}/repos/o/r/pulls/1` } },
    })

    await expect(
      findPullRequest(client({}, enterprise), {
        ...BASE,
        apiUrl: enterprise,
        eventName: 'repository_dispatch',
        eventPath,
      })
    ).resolves.toBe(`${enterprise}/repos/o/r/pulls/1`)
  })
})

describe('paging', () => {
  it('reads the next link', () => {
    expect(
      nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"')
    ).toBe('https://api.github.com/x?page=2')
  })

  it('returns nothing on the last page', () => {
    expect(nextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeUndefined()
  })

  it('handles a missing header', () => {
    expect(nextLink(null)).toBeUndefined()
  })
})

describe('identifying the token user', () => {
  it('prefers the graphql viewer', async () => {
    const fetchImpl = (async (url: string) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () =>
        String(url).includes('graphql')
          ? { data: { viewer: { login: 'from-graphql' } } }
          : { login: 'from-rest' },
    })) as unknown as typeof fetch

    const github = new GitHubClient({ token: 't', fetchImpl })
    await expect(github.currentUser()).resolves.toBe('from-graphql')
  })

  /** App tokens have no REST endpoint for this; fine-grained PATs have no graphql. */
  it('falls back to rest when graphql is unavailable', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('graphql')) return { ok: false, status: 401, headers: new Headers() }
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ login: 'from-rest' }) }
    }) as unknown as typeof fetch

    const github = new GitHubClient({ token: 't', fetchImpl })
    await expect(github.currentUser()).resolves.toBe('from-rest')
  })

  it('falls back to the bot login when neither works', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 403,
      headers: new Headers(),
    })) as unknown as typeof fetch

    const github = new GitHubClient({ token: 't', fetchImpl })
    await expect(github.currentUser()).resolves.toBe('github-actions[bot]')
  })
})

/**
 * Both of these take values that can be arbitrarily long: an API url from
 * configuration, and a Link header from a response.
 */
describe('parsing cost', () => {
  it('strips trailing slashes promptly', () => {
    const started = Date.now()
    const github = new GitHubClient({ token: 't', apiUrl: `https://h${'/'.repeat(80_000)}` })
    expect(github.apiUrl).toBe('https://h')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('reads a link header promptly when it nearly matches', () => {
    const started = Date.now()
    expect(nextLink('<'.repeat(80_000))).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('still strips a single trailing slash', () => {
    expect(new GitHubClient({ token: 't', apiUrl: 'https://api.github.com/' }).apiUrl).toBe(
      'https://api.github.com'
    )
  })

  it('leaves a url with no trailing slash alone', () => {
    expect(new GitHubClient({ token: 't', apiUrl: 'https://api.github.com' }).apiUrl).toBe(
      'https://api.github.com'
    )
  })
})
