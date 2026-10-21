import { jobUrl } from '../src/actions/workflow.js'

/**
 * The link a plan comment offers back to the run that produced it.
 *
 * On GitHub this is assembled from the run variables. On Depot, which executes
 * GitHub Actions workflows on its own infrastructure, that URL points at a run
 * that does not exist, so Depot supplies the real one.
 */
describe('jobUrl', () => {
  const saved = process.env

  beforeEach(() => {
    process.env = { ...saved }
    delete process.env.DEPOT_JOB_URL
    process.env.GITHUB_SERVER_URL = 'https://github.com'
    process.env.GITHUB_REPOSITORY = 'acme/widgets'
    process.env.GITHUB_RUN_ID = '42'
  })

  afterEach(() => {
    process.env = saved
  })

  it('builds the run URL from the GitHub variables', () => {
    expect(jobUrl()).toBe('https://github.com/acme/widgets/actions/runs/42')
  })

  it('uses the Depot URL when one is supplied', () => {
    process.env.DEPOT_JOB_URL = 'https://depot.dev/orgs/acme/projects/p/runs/7'

    expect(jobUrl()).toBe('https://depot.dev/orgs/acme/projects/p/runs/7')
  })

  it('prefers Depot even though the GitHub variables are also set', () => {
    // Depot populates the GitHub variables too, so both are always present
    // there; preferring GitHub would mean the link never worked on Depot.
    process.env.DEPOT_JOB_URL = 'https://depot.dev/job'

    expect(jobUrl()).toBe('https://depot.dev/job')
  })

  it('ignores an empty Depot URL', () => {
    process.env.DEPOT_JOB_URL = ''

    expect(jobUrl()).toBe('https://github.com/acme/widgets/actions/runs/42')
  })

  it('honours a GitHub Enterprise server URL', () => {
    process.env.GITHUB_SERVER_URL = 'https://ghe.example.com'

    expect(jobUrl()).toBe('https://ghe.example.com/acme/widgets/actions/runs/42')
  })

  it.each(['GITHUB_SERVER_URL', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID'])(
    'is undefined without %s, rather than building a broken link',
    (name) => {
      delete process.env[name]

      expect(jobUrl()).toBeUndefined()
    }
  )

  it('still returns the Depot URL when the GitHub variables are missing', () => {
    delete process.env.GITHUB_RUN_ID
    process.env.DEPOT_JOB_URL = 'https://depot.dev/job'

    expect(jobUrl()).toBe('https://depot.dev/job')
  })
})