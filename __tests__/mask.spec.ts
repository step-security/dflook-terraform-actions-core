import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { Masker, maskOptionsFromEnv, maskOutput } from '../src/terraform/mask.js'

const FIXTURES = join(__dirname, 'fixtures', 'mask')

/**
 * The expected files were produced by running the `tfmask` tool that upstream
 * pipes its output through, so they record what upstream actually emits rather
 * than our reading of the rules. See fixtures/mask/README.md to regenerate.
 */
describe('parity with upstream masking', () => {
  const inputs = readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.txt') && !name.endsWith('.expected.txt'))
    .sort()

  it('has fixtures to compare', () => {
    expect(inputs.length).toBeGreaterThan(0)
  })

  it.each(inputs)('matches on %s', (name) => {
    const input = readFileSync(join(FIXTURES, name), 'utf8')
    const expected = readFileSync(join(FIXTURES, name.replace(/\.txt$/, '.expected.txt')), 'utf8')

    // The 0.11 fixture exercises the older output dialect, which the tool
    // selects by configuration rather than by detection.
    const dialect = name.includes('0.11') ? '0.11' : '0.12'

    expect(maskOutput(input, { dialect })).toBe(expected)
  })
})

describe('what gets masked', () => {
  const mask = (line: string) => new Masker().line(line)

  it.each([
    ['a secret', '        client_secret = "abc"'],
    ['a token', '        oauth_token = "xyz"'],
    ['a key', '        api_key = "k-1"'],
    ['a generated result', '        random_result = "r"'],
    ['a nested attribute', '        stage.0.configuration.OAuthToken = "t"'],
  ])('masks %s', (_label, line) => {
    expect(mask(line)).toMatch(/"\*+"/)
  })

  it('leaves an ordinary attribute alone', () => {
    const line = '        plain_name = "visible"'
    expect(mask(line)).toBe(line)
  })

  /**
   * Masking is driven by the attribute name, not by Terraform's own sensitive
   * marking. Worth pinning down, because it is the rule's main limitation.
   */
  it('does not mask a sensitive value under an innocuous name', () => {
    const line = '        config = "actually-a-secret"'
    expect(mask(line)).toBe(line)
  })

  /**
   * A real gap in the upstream rules, reproduced deliberately rather than
   * fixed. The default pattern requires a non-alphabetic character immediately
   * before the keyword — `[^a-zA-Z](password|secret|...)` — so `api_key` matches
   * on `_key` but a bare `password` has nothing before it and does not match.
   *
   * Diverging here would mask values upstream leaves visible, which sounds like
   * an improvement until a workflow diffs the two outputs. Callers who want the
   * stricter behaviour can pass their own pattern; see the README.
   */
  it('reproduces upstream leaving a bare password unmasked', () => {
    const line = '        password = "hunter2"'
    expect(mask(line)).toBe(line)
  })

  it('masks the same attribute once something precedes it', () => {
    expect(mask('        db_password = "hunter2"')).toBe('        db_password = "*******"')
  })
})

describe('values that state the absence of a value', () => {
  it.each(['sensitive', 'computed', '<computed', 'known after apply'])(
    'leaves %s readable',
    (value) => {
      const line = `      ~ password = "before" -> (${value})`
      expect(new Masker().line(line)).toContain(`(${value})`)
    }
  )

  it('still masks the value beside it', () => {
    const line = '      ~ password = "before" -> (known after apply)'
    expect(new Masker().line(line)).toContain('"******"')
  })
})

describe('resource ids', () => {
  it('masks the id of a resource that exists to hold a secret', () => {
    const line = 'random_id.some_id: Creation complete after 0s [id=YfK9aF]'
    expect(new Masker().line(line)).toBe(
      'random_id.some_id: Creation complete after 0s [id=******]'
    )
  })

  it('leaves an ordinary resource id readable', () => {
    const line = 'aws_db_instance.main: Modifying... [id=db-9999]'
    expect(new Masker().line(line)).toBe(line)
  })
})

describe('mask length', () => {
  /**
   * The mask is one character per code point. Counting UTF-16 units instead
   * would report a longer value than there is, leaking its true length.
   */
  it('counts astral characters once', () => {
    const line = '        secret_key = "🔑🔑🔑"'
    expect(new Masker().line(line)).toBe('        secret_key = "***"')
  })

  it('handles an empty value', () => {
    expect(new Masker().line('        token = ""')).toBe('        token = ""')
  })
})

describe('configuration from the environment', () => {
  it('reads the same variables as the underlying tool', () => {
    const options = maskOptionsFromEnv({
      TFMASK_CHAR: '#',
      TFMASK_VALUES_REGEX: '(?i)^.*custom.*$',
      TFMASK_RESOURCES_REGEX: '^my_resource.*$',
      TFENV: '0.11',
    } as NodeJS.ProcessEnv)

    expect(options).toEqual({
      maskChar: '#',
      valuesPattern: '(?i)^.*custom.*$',
      resourcesPattern: '^my_resource.*$',
      dialect: '0.11',
    })
  })

  it('applies a custom mask character and pattern', () => {
    const masked = new Masker({ maskChar: '#', valuesPattern: '(?i)^.*custom.*$' }).line(
      '        custom_thing = "abcd"'
    )
    expect(masked).toBe('        custom_thing = "####"')
  })

  it('defaults to the wider resource list upstream sets', () => {
    const options = maskOptionsFromEnv({} as NodeJS.ProcessEnv)
    expect(options.resourcesPattern).toContain('kubernetes_secret')
    expect(options.resourcesPattern).toContain('acme_certificate')
  })
})

/**
 * Go supports `(?i)` as an inline flag; JavaScript rejects the sequence
 * entirely. Since these patterns are overridable through the environment, an
 * untranslated one would throw at construction rather than mask anything.
 */
describe('translating Go patterns', () => {
  it('accepts an inline case-insensitivity flag', () => {
    expect(() => new Masker({ valuesPattern: '(?i)^.*PASSWORD.*$' })).not.toThrow()
    expect(new Masker({ valuesPattern: '(?i)^.*PASSWORD.*$' }).line('        password = "a"')).toBe(
      '        password = "*"'
    )
  })

  it('respects a case-sensitive pattern', () => {
    const masker = new Masker({ valuesPattern: '^.*PASSWORD.*$' })
    const line = '        password = "a"'
    expect(masker.line(line)).toBe(line)
  })
})

describe('preserving the shape of the output', () => {
  it('keeps a trailing newline', () => {
    expect(maskOutput('        plain = "a"\n')).toBe('        plain = "a"\n')
  })

  it('does not add one', () => {
    expect(maskOutput('        plain = "a"')).toBe('        plain = "a"')
  })

  it('passes an empty stream through', () => {
    expect(maskOutput('')).toBe('')
  })
})
