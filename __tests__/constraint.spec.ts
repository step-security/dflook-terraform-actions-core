import { Constraint, applyConstraints, parseConstraints } from '../src/version/constraint'
import { Version } from '../src/version/version'

const allows = (constraint: string, version: string) =>
  new Constraint(constraint).isAllowed(new Version(version))

describe('parsing', () => {
  it('defaults to equality when no operator is given', () => {
    expect(new Constraint('1.5.0').operator).toBe('=')
  })

  it('ignores whitespace around the operator', () => {
    expect(new Constraint('>=  1.5').toString()).toBe('>=1.5')
  })

  it('accepts a v prefix', () => {
    expect(new Constraint('>=v1.5.0').major).toBe(1)
  })

  it('leaves omitted components undefined rather than zero', () => {
    const partial = new Constraint('~> 1')
    expect(partial.minor).toBeUndefined()
    expect(partial.patch).toBeUndefined()
  })
})

describe('exact and inequality operators', () => {
  it('matches an exact version', () => {
    expect(allows('1.5.0', '1.5.0')).toBe(true)
    expect(allows('1.5.0', '1.5.1')).toBe(false)
  })

  it('treats omitted components as zero', () => {
    expect(allows('=1.5', '1.5.0')).toBe(true)
    expect(allows('=1.5', '1.5.1')).toBe(false)
  })

  it.each([
    ['>1.5.0', '1.5.1', true],
    ['>1.5.0', '1.5.0', false],
    ['>=1.5.0', '1.5.0', true],
    ['>=1.5.0', '1.4.9', false],
    ['<1.5.0', '1.4.9', true],
    ['<1.5.0', '1.5.0', false],
    ['<=1.5.0', '1.5.0', true],
    ['<=1.5.0', '1.5.1', false],
    ['!=1.5.0', '1.5.1', true],
    ['!=1.5.0', '1.5.0', false],
  ])('%s allows %s → %s', (constraint, version, expected) => {
    expect(allows(constraint, version)).toBe(expected)
  })
})

/**
 * The single most surprising rule: only `=` can ever select a pre-release. Any
 * comparison operator refuses them outright, so `>= 1.0` will not pick up
 * 1.6.0-rc1 even though it is numerically greater.
 */
describe('pre-release handling', () => {
  it('allows a pre-release only through exact equality', () => {
    expect(allows('=1.6.0-rc1', '1.6.0-rc1')).toBe(true)
  })

  it.each(['>=1.0.0', '>1.0.0', '<2.0.0', '<=2.0.0', '!=9.9.9', '~>1.6'])(
    '%s refuses a pre-release',
    (constraint) => {
      expect(allows(constraint, '1.6.0-rc1')).toBe(false)
    }
  )

  it('still allows the final release of the same number', () => {
    expect(allows('>=1.0.0', '1.6.0')).toBe(true)
  })
})

describe('the pessimistic operator', () => {
  it('with major.minor.patch, pins minor and lets patch grow', () => {
    expect(allows('~>1.5.0', '1.5.0')).toBe(true)
    expect(allows('~>1.5.0', '1.5.9')).toBe(true)
    expect(allows('~>1.5.0', '1.6.0')).toBe(false)
    expect(allows('~>1.5.2', '1.5.1')).toBe(false)
  })

  it('with major.minor, pins major and lets minor grow', () => {
    expect(allows('~>1.5', '1.5.0')).toBe(true)
    expect(allows('~>1.5', '1.9.9')).toBe(true)
    expect(allows('~>1.5', '2.0.0')).toBe(false)
    expect(allows('~>1.5', '1.4.9')).toBe(false)
  })

  /**
   * With only a major given, the operator is far looser than the name suggests:
   * it permits any major at or above the bound, not just that major series.
   */
  it('with major only, permits any later major', () => {
    expect(allows('~>1', '1.0.0')).toBe(true)
    expect(allows('~>1', '2.0.0')).toBe(true)
    expect(allows('~>1', '9.9.9')).toBe(true)
    expect(allows('~>1', '0.15.0')).toBe(false)
  })
})

describe('combining constraints', () => {
  const versions = ['0.12.31', '1.4.0', '1.5.0', '1.5.7', '1.6.0', '2.0.0', '1.6.0-rc1'].map(
    (text) => new Version(text)
  )

  it('keeps only versions permitted by every constraint', () => {
    const kept = applyConstraints(versions, parseConstraints('>= 1.5, < 2.0'))
    expect(kept.map(String).sort()).toEqual(['1.5.0', '1.5.7', '1.6.0'])
  })

  it('excludes a specific version', () => {
    const kept = applyConstraints(versions, parseConstraints('>= 1.5, != 1.5.7, < 2.0'))
    expect(kept.map(String).sort()).toEqual(['1.5.0', '1.6.0'])
  })

  it('returns everything when there are no constraints', () => {
    expect(applyConstraints(versions, [])).toHaveLength(versions.length)
  })

  it('can exclude everything', () => {
    expect(applyConstraints(versions, parseConstraints('>= 99.0'))).toEqual([])
  })

  it('drops clauses it cannot parse rather than failing the run', () => {
    // Terraform tolerates expressions it cannot act on, so selection must too.
    const parsed = parseConstraints('>= 1.5, something-odd')
    expect(parsed).toHaveLength(1)
    expect(parsed[0].toString()).toBe('>=1.5')
  })

  it('ignores empty clauses and trailing commas', () => {
    expect(parseConstraints('>= 1.5, ,')).toHaveLength(1)
  })
})
