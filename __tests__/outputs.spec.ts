import {
  OutputParseError,
  flattenOutputs,
  outputCommands,
  parseOutputs,
} from '../src/terraform/outputs.js'

describe('parsing terraform output -json', () => {
  it('reads the outputs', () => {
    const parsed = parseOutputs('{"name":{"type":"string","value":"web","sensitive":false}}')
    expect(parsed.name.value).toBe('web')
  })

  /** Terraform sometimes writes warnings to stdout ahead of the document. */
  it('skips noise before the JSON', () => {
    const parsed = parseOutputs(
      'Warning: something\nStill initializing\n{"a":{"type":"string","value":"1"}}'
    )
    expect(parsed.a.value).toBe('1')
  })

  it('fails when there is no JSON at all', () => {
    expect(() => parseOutputs('total failure to connect')).toThrow(OutputParseError)
  })

  it('fails on a JSON array rather than accepting it', () => {
    expect(() => parseOutputs('{}\n'.replace('{}', '[]'))).toThrow(OutputParseError)
  })

  it('accepts no outputs', () => {
    expect(parseOutputs('{}')).toEqual({})
  })
})

describe('publishing primitive outputs', () => {
  it('publishes a string', () => {
    expect(outputCommands({ a: { type: 'string', value: 'hello' } })).toEqual([
      { kind: 'output', name: 'a', value: 'hello' },
    ])
  })

  it('publishes a number as text', () => {
    expect(outputCommands({ a: { type: 'number', value: 42 } })).toEqual([
      { kind: 'output', name: 'a', value: '42' },
    ])
  })

  /** A bool goes through JSON so it reads as `true`, not `True` or `1`. */
  it('publishes a bool as json', () => {
    expect(outputCommands({ a: { type: 'bool', value: true } })).toEqual([
      { kind: 'output', name: 'a', value: 'true' },
    ])
  })
})

describe('publishing complex outputs', () => {
  it('publishes an object as compact json', () => {
    expect(outputCommands({ a: { type: ['object', {}], value: { b: 1 } } })).toEqual([
      { kind: 'output', name: 'a', value: '{"b":1}' },
    ])
  })

  it('publishes a list as compact json', () => {
    expect(outputCommands({ a: { type: ['list', 'string'], value: ['x', 'y'] } })).toEqual([
      { kind: 'output', name: 'a', value: '["x","y"]' },
    ])
  })
})

/**
 * The masking is the point of this module. A sensitive output that is published
 * without being masked first is visible in the job log, and the log is kept.
 */
describe('masking sensitive outputs', () => {
  it('masks a sensitive string', () => {
    expect(outputCommands({ a: { type: 'string', value: 'hunter2', sensitive: true } })).toEqual([
      { kind: 'mask', value: 'hunter2' },
      { kind: 'output', name: 'a', value: 'hunter2' },
    ])
  })

  it('masks a sensitive complex value', () => {
    const commands = outputCommands({
      a: { type: ['object', {}], value: { token: 'abc' }, sensitive: true },
    })
    expect(commands[0]).toEqual({ kind: 'mask', value: '{"token":"abc"}' })
  })

  it('asks for the mask before the value it covers', () => {
    const commands = outputCommands({ a: { type: 'string', value: 's', sensitive: true } })
    expect(commands.findIndex((c) => c.kind === 'mask')).toBeLessThan(
      commands.findIndex((c) => c.kind === 'output')
    )
  })

  it('does not mask a value that is not sensitive', () => {
    const commands = outputCommands({ a: { type: 'string', value: 'public' } })
    expect(commands.some((c) => c.kind === 'mask')).toBe(false)
  })

  /**
   * A sensitive value whose type is not published still has to be masked. It can
   * reach the log through the plan or apply output even if it is not a step
   * output.
   */
  it('masks a sensitive value of an unpublished primitive type', () => {
    const commands = outputCommands({ a: { type: 'weird', value: 'secret', sensitive: true } })
    expect(commands).toEqual([{ kind: 'mask', value: 'secret' }])
  })
})

describe('flattening for the json artifact', () => {
  it('keeps only the values', () => {
    expect(
      flattenOutputs({
        b: { type: 'string', value: '2' },
        a: { type: 'number', value: 1 },
      })
    ).toEqual({ a: 1, b: '2' })
  })

  /** Sorted so the artifact is stable between runs and diffs cleanly. */
  it('sorts by name', () => {
    const flattened = flattenOutputs({
      z: { type: 'string', value: 'z' },
      a: { type: 'string', value: 'a' },
      m: { type: 'string', value: 'm' },
    })
    expect(Object.keys(flattened)).toEqual(['a', 'm', 'z'])
  })
})
