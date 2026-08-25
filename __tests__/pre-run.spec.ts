import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const exec = jest.fn()
jest.mock('@actions/exec', () => ({ exec }))

const groups: string[] = []
const stopped: boolean[] = []
jest.mock('../src/actions/workflow', () => ({
  startGroup: (title: string) => groups.push(title),
  endGroup: () => groups.push('<end>'),
  info: () => undefined,
  withWorkflowCommandsStopped: async <T>(action: () => Promise<T>): Promise<T> => {
    stopped.push(true)
    return action()
  },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PreRunError, runPreRunCommands } = require('../src/setup/pre-run')

beforeEach(() => {
  jest.clearAllMocks()
  groups.length = 0
  stopped.length = 0
  exec.mockResolvedValue(0)
})

describe('TERRAFORM_PRE_RUN', () => {
  it('does nothing when unset', async () => {
    await expect(runPreRunCommands(undefined)).resolves.toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it('does nothing for a blank value', async () => {
    await expect(runPreRunCommands('   \n  ')).resolves.toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it('writes the script and runs it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pre-run-'))
    await expect(runPreRunCommands('echo hello', { scriptDir: dir })).resolves.toBe(true)

    const path = join(dir, 'TERRAFORM_PRE_RUN.sh')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('echo hello')
    expect(exec).toHaveBeenCalledWith('bash', ['-xeo', 'pipefail', path], expect.anything())
  })

  /**
   * `-e` and `-o pipefail` mean a failing command stops the run rather than
   * letting Terraform proceed with a half-prepared environment; `-x` puts each
   * command in the log so a failure is diagnosable.
   */
  it('runs the script with tracing and fail-fast enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pre-run-'))
    await runPreRunCommands('true', { scriptDir: dir })

    const args = exec.mock.calls[0][1] as string[]
    expect(args).toContain('-xeo')
    expect(args).toContain('pipefail')
  })

  /**
   * The script's output is entirely caller-controlled. Without suspending
   * workflow commands, a line of its output could pose as an instruction to the
   * runner — setting an output, adding a mask, exporting an environment
   * variable.
   */
  it('suspends workflow commands while the script runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pre-run-'))
    await runPreRunCommands('echo "::set-output name=x::y"', { scriptDir: dir })

    expect(stopped).toEqual([true])
  })

  it('fails the run when the script exits non-zero', async () => {
    exec.mockResolvedValue(2)
    const dir = mkdtempSync(join(tmpdir(), 'pre-run-'))

    await expect(runPreRunCommands('false', { scriptDir: dir })).rejects.toThrow(PreRunError)
    await expect(runPreRunCommands('false', { scriptDir: dir })).rejects.toThrow(/exit code 2/)
  })

  it('closes the log group even when the script fails', async () => {
    exec.mockResolvedValue(1)
    const dir = mkdtempSync(join(tmpdir(), 'pre-run-'))

    await expect(runPreRunCommands('false', { scriptDir: dir })).rejects.toThrow()
    expect(groups).toEqual(['Executing TERRAFORM_PRE_RUN', '<end>'])
  })
})
