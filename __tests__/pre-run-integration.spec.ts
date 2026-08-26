import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PreRunError, runPreRunCommands } from '../src/setup/pre-run.js'

/**
 * `pre-run.spec.ts` mocks the command runner to assert how the script is
 * invoked. These tests deliberately do not, so the script is really written to
 * disk and really executed by bash.
 *
 * Worth having separately: `TERRAFORM_PRE_RUN` runs arbitrary commands supplied
 * through the environment, so "the arguments looked right" is a weaker claim
 * than "the commands ran and their exit code was respected".
 */

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pre-run-real-'))
})

describe('really running the commands', () => {
  it('executes them', async () => {
    const marker = join(tempDir, 'ran')
    await runPreRunCommands(`touch '${marker}'`, { scriptDir: tempDir })

    expect(existsSync(marker)).toBe(true)
  })

  it('runs several commands in order', async () => {
    const log = join(tempDir, 'log')
    await runPreRunCommands(`echo first >> '${log}'\necho second >> '${log}'`, { scriptDir: tempDir })

    expect(readFileSync(log, 'utf8')).toBe('first\nsecond\n')
  })

  /**
   * The script runs with `-e`, so a failure part way through has to stop it
   * rather than carrying on to the next command.
   */
  it('stops at the first failing command', async () => {
    const log = join(tempDir, 'log')
    await expect(
      runPreRunCommands(`echo before >> '${log}'\nfalse\necho after >> '${log}'`, { scriptDir: tempDir })
    ).rejects.toThrow(PreRunError)

    expect(readFileSync(log, 'utf8')).toBe('before\n')
  })

  it('fails when a command is not found', async () => {
    await expect(
      runPreRunCommands('definitely-not-a-real-command-xyz', { scriptDir: tempDir })
    ).rejects.toThrow(PreRunError)
  })

  /**
   * `pipefail` is set, so a failure on the left of a pipe must not be hidden by
   * a success on the right.
   */
  it('does not let a pipe hide a failure', async () => {
    await expect(runPreRunCommands('false | cat', { scriptDir: tempDir })).rejects.toThrow(PreRunError)
  })

  /** Resolves true to say it ran, as distinct from there being nothing to run. */
  it('reports that it ran when the commands succeed', async () => {
    await expect(runPreRunCommands('true', { scriptDir: tempDir })).resolves.toBe(true)
  })

  it('makes environment variables available to the script', async () => {
    const log = join(tempDir, 'log')
    process.env.PRE_RUN_FIXTURE = 'visible'
    try {
      await runPreRunCommands(`echo "$PRE_RUN_FIXTURE" > '${log}'`, { scriptDir: tempDir })
      expect(readFileSync(log, 'utf8').trim()).toBe('visible')
    } finally {
      delete process.env.PRE_RUN_FIXTURE
    }
  })
})
