import { readFileSync } from 'fs'
import { join } from 'path'
import {
  getBackend,
  getRequiredVersion,
  getSensitiveVariables,
  parseJsonModule,
  readJsonModule,
  toBlockList,
} from '../src/terraform/tf-json.js'

/**
 * Parity with the upstream JSON parser.
 *
 * The expectations in `tf-json-parity.json` were produced by running upstream's
 * own `terraform/tf_json.py` over each input and recording what it returned,
 * rather than by reading the code and writing down what it looked like it did.
 * That distinction has caught real differences before: the reordering of blocks
 * and the handling of a non-string `required_version` are both things a careful
 * reading got wrong.
 */
interface ParityCase {
  name: string
  input: unknown
  throws?: boolean
  expected?: {
    requiredVersion: string | null
    backend: { type: string; config: Record<string, unknown> } | null
    sensitiveVariables: string[]
  }
}

const cases: ParityCase[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'tf-json-parity.json'), 'utf8')
)

describe('parity with the upstream JSON parser', () => {
  const accepted = cases.filter((c) => !c.throws)
  const rejected = cases.filter((c) => c.throws)

  it('covers every recorded case', () => {
    expect(cases.length).toBe(46)
    expect(rejected.length).toBe(5)
  })

  it.each(accepted.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const facts = readJsonModule(testCase.input)
    const expected = testCase.expected!

    expect(facts.requiredVersion ?? null).toEqual(expected.requiredVersion)
    expect(facts.backend ?? null).toEqual(expected.backend)
    expect([...facts.sensitiveVariables]).toEqual(expected.sensitiveVariables)
  })

  it.each(rejected.map((c) => [c.name, c] as const))(
    'rejects: %s',
    (_name, testCase) => {
      // Upstream raises here, and its caller drops the whole file. Returning
      // partial facts instead would be worse than ignoring the file: a backend
      // could be fingerprinted from a file whose variable blocks never parsed.
      expect(() => readJsonModule(testCase.input)).toThrow()
    }
  )
})

describe('toBlockList', () => {
  it('wraps a single object as a one-block list', () => {
    expect(toBlockList({ a: 1 })).toEqual([{ a: 1 }])
  })

  it('passes an array through', () => {
    expect(toBlockList([{ a: 1 }, { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('treats anything else as no blocks at all', () => {
    for (const value of ['text', 42, true, null, undefined]) {
      expect(toBlockList(value)).toEqual([])
    }
  })
})

describe('getRequiredVersion', () => {
  it('reads the object form', () => {
    expect(getRequiredVersion({ terraform: { required_version: '>= 1.5' } })).toBe('>= 1.5')
  })

  it('reads the array form', () => {
    expect(getRequiredVersion({ terraform: [{ required_version: '>= 1.5' }] })).toBe('>= 1.5')
  })

  it('finds it in a later terraform block', () => {
    expect(
      getRequiredVersion({ terraform: [{ backend: { s3: {} } }, { required_version: '~> 1.0' }] })
    ).toBe('~> 1.0')
  })

  it('is undefined when absent', () => {
    expect(getRequiredVersion({ terraform: { backend: { s3: {} } } })).toBeUndefined()
    expect(getRequiredVersion({})).toBeUndefined()
  })
})

describe('getBackend', () => {
  it('prefers a cloud block over a backend block in the same terraform block', () => {
    const backend = getBackend({
      terraform: { cloud: { organization: 'org' }, backend: { s3: { bucket: 'b' } } },
    })
    expect(backend?.type).toBe('cloud')
  })

  it('normalises workspaces to a list, whichever form it was written in', () => {
    const asObject = getBackend({ terraform: { cloud: { workspaces: { name: 'ws' } } } })
    const asArray = getBackend({ terraform: { cloud: { workspaces: [{ name: 'ws' }] } } })

    expect(asObject?.config.workspaces).toEqual([{ name: 'ws' }])
    expect(asArray?.config.workspaces).toEqual([{ name: 'ws' }])
  })

  it('takes the first label when a backend block has several', () => {
    const backend = getBackend({
      terraform: { backend: { s3: { bucket: 'b' }, local: { path: 'p' } } },
    })
    expect(backend?.type).toBe('s3')
  })

  it('merges a body written as several objects', () => {
    const backend = getBackend({ terraform: { backend: { s3: [{ bucket: 'b' }, { key: 'k' }] } } })
    expect(backend?.config).toEqual({ bucket: 'b', key: 'k' })
  })

  it('gives up on an unlabelled backend rather than looking further', () => {
    // `"backend": {}` has no label to read, and upstream returns at that point
    // instead of continuing to the next terraform block.
    expect(
      getBackend({ terraform: [{ backend: {} }, { backend: { s3: { bucket: 'b' } } }] })
    ).toBeUndefined()
  })
})

describe('getSensitiveVariables', () => {
  it('accepts a literal true and the string "true"', () => {
    expect(getSensitiveVariables({ variable: { a: { sensitive: true } } })).toEqual(['a'])
    expect(getSensitiveVariables({ variable: { b: { sensitive: 'true' } } })).toEqual(['b'])
  })

  it('rejects everything else, including 1', () => {
    // Terraform itself rejects `sensitive = 1`, so treating it as sensitive
    // here would mask a value that really does appear in plan output, which
    // reads as a bug to anyone comparing the comment with the plan.
    for (const sensitive of [1, 'yes', 'True', false, 'false', null]) {
      expect(getSensitiveVariables({ variable: { a: { sensitive } } })).toEqual([])
    }
  })

  it('collects names across several variable blocks', () => {
    expect(
      getSensitiveVariables({
        variable: [{ a: { sensitive: true } }, { b: { sensitive: true }, c: { sensitive: true } }],
      })
    ).toEqual(['a', 'b', 'c'])
  })
})

describe('parseJsonModule', () => {
  it('reads a document from text', () => {
    const facts = parseJsonModule('{"terraform": {"required_version": ">= 1.5"}}')
    expect(facts.requiredVersion).toBe('>= 1.5')
  })

  it('throws on text that is not JSON', () => {
    expect(() => parseJsonModule('terraform { }')).toThrow()
  })

  it('throws on a JSON document that is not an object', () => {
    expect(() => parseJsonModule('[]')).toThrow()
    expect(() => parseJsonModule('"text"')).toThrow()
  })
})