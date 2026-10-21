import { mkdtempSync, writeFileSync } from 'fs'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import {
  filesInModule,
  getBackendType,
  getSensitiveVariables,
  getVersionConstraints,
  loadModule,
} from '../src/terraform/module.js'

/**
 * Whole-module parity with upstream.
 *
 * `tf-json.spec.ts` checks the JSON parser in isolation. This checks what the
 * consumers actually see once a directory has been read: which files were
 * chosen, the version constraint, the backend type, and the sensitive variable
 * names. Those are the four answers the rest of the action is built on.
 *
 * The expectations were recorded by running upstream's own `module.py` over
 * these exact directories. See `fixtures/README-tf-json-parity.md`.
 */

interface ModuleFacts {
  files: string[]
  version: string[] | null
  backendType: string
  sensitive: string[]
}

interface ParityCase {
  name: string
  files: Record<string, string>
  upstream: { tf: ModuleFacts; tofu: ModuleFacts }
}

const fixture: { cases: ParityCase[] } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'module-json-parity.json'), 'utf8')
)

/**
 * Upstream reads the directory with `Path.iterdir()`, which is not ordered.
 * When two files each declare a backend it answers from whichever came back
 * first, so the same configuration gives different answers on different
 * filesystems. We sort the directory and prefer HCL, which is at least stable.
 * Terraform does not accept two backend blocks in one module anyway.
 */
const UNDEFINED_UPSTREAM_ORDER = new Set(['hcl-backend-json-backend'])

function materialise(testCase: ParityCase): string {
  const dir = mkdtempSync(join(tmpdir(), `parity-${testCase.name}-`))
  for (const [name, body] of Object.entries(testCase.files)) {
    writeFileSync(join(dir, name), body)
  }
  return dir
}

function ourFacts(dir: string, openTofu: boolean): ModuleFacts {
  const module = loadModule(dir, openTofu)
  const constraints = getVersionConstraints(module)

  return {
    files: filesInModule(dir, openTofu)
      .map((file) => basename(file))
      .sort(),
    version: constraints ? constraints.map((c) => c.toString()) : null,
    backendType: getBackendType(module),
    sensitive: [...getSensitiveVariables(module)].sort(),
  }
}

describe.each(fixture.cases.map((c) => [c.name, c] as const))(
  'module parity: %s',
  (name, testCase) => {
    const dir = materialise(testCase)

    for (const mode of ['tf', 'tofu'] as const) {
      const openTofu = mode === 'tofu'
      const expected = testCase.upstream[mode]

      describe(openTofu ? 'with OpenTofu' : 'with Terraform', () => {
        it('reads the same files', () => {
          expect(ourFacts(dir, openTofu).files).toEqual(expected.files)
        })

        it('reports the same version constraint', () => {
          expect(ourFacts(dir, openTofu).version).toEqual(expected.version)
        })

        it('reports the same sensitive variables', () => {
          expect(ourFacts(dir, openTofu).sensitive).toEqual(expected.sensitive)
        })

        if (UNDEFINED_UPSTREAM_ORDER.has(name)) {
          it('answers deterministically where upstream does not', () => {
            // Both orderings are "correct" upstream depending on the
            // filesystem. Pinning ours means a change here is visible.
            expect(ourFacts(dir, openTofu).backendType).toBe('local')
          })
        } else {
          it('reports the same backend type', () => {
            expect(ourFacts(dir, openTofu).backendType).toEqual(expected.backendType)
          })
        }
      })
    }
  }
)

describe('coverage of the recorded cases', () => {
  it('runs every case that was recorded', () => {
    expect(fixture.cases).toHaveLength(16)
  })

  it('only excuses the one case upstream leaves undefined', () => {
    expect([...UNDEFINED_UPSTREAM_ORDER]).toEqual(['hcl-backend-json-backend'])
  })
})