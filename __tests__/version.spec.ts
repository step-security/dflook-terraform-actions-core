import {
  InvalidVersion,
  Version,
  compareVersions,
  earliestFinalVersion,
  latestFinalVersion,
  latestVersion,
  sortVersions,
  tryParseVersion,
} from '../src/version/version'

const v = (s: string) => new Version(s)

describe('parsing', () => {
  it('reads the numeric components', () => {
    const parsed = v('1.15.9')
    expect([parsed.major, parsed.minor, parsed.patch, parsed.preRelease]).toEqual([1, 15, 9, ''])
  })

  it('reads a pre-release suffix', () => {
    expect(v('1.6.0-alpha3').preRelease).toBe('alpha3')
  })

  it('reads a hyphenated pre-release suffix', () => {
    expect(v('1.6.0-rc1-patch2').preRelease).toBe('rc1-patch2')
  })

  it('defaults the product to Terraform', () => {
    expect(v('1.0.0').product).toBe('Terraform')
  })

  it('carries an explicit product', () => {
    expect(new Version('1.6.0', 'OpenTofu').product).toBe('OpenTofu')
  })

  it.each(['1.5', 'v1.5.0', 'latest', '', 'x.y.z'])('rejects %s', (bad) => {
    expect(() => v(bad)).toThrow(InvalidVersion)
  })

  it('returns undefined instead of throwing when asked to try', () => {
    expect(tryParseVersion('nonsense')).toBeUndefined()
    expect(tryParseVersion(' 1.2.3 ')?.toString()).toBe('1.2.3')
  })
})

describe('round-tripping to string', () => {
  it.each(['1.15.9', '1.6.0-alpha3', '0.12.31'])('preserves %s', (text) => {
    expect(v(text).toString()).toBe(text)
  })
})

describe('ordering', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions(v('2.0.0'), v('1.9.9'))).toBeGreaterThan(0)
    expect(compareVersions(v('1.9.0'), v('1.10.0'))).toBeLessThan(0)
    expect(compareVersions(v('1.5.2'), v('1.5.10'))).toBeLessThan(0)
  })

  it('compares components numerically, not as text', () => {
    // A lexical sort would put 1.10.0 below 1.9.0.
    expect(sortVersions([v('1.9.0'), v('1.10.0')]).map(String)).toEqual(['1.9.0', '1.10.0'])
  })

  /**
   * The rule that catches people out: a final release outranks any pre-release
   * of the same number.
   */
  it('ranks a final release above its own pre-releases', () => {
    expect(compareVersions(v('1.6.0'), v('1.6.0-rc1'))).toBeGreaterThan(0)
    expect(compareVersions(v('1.6.0-rc1'), v('1.6.0'))).toBeLessThan(0)
  })

  it('orders pre-releases against each other as strings', () => {
    expect(compareVersions(v('1.6.0-alpha'), v('1.6.0-beta'))).toBeLessThan(0)
  })

  it('treats identical versions as equal', () => {
    expect(compareVersions(v('1.2.3'), v('1.2.3'))).toBe(0)
    expect(v('1.2.3').equals(v('1.2.3'))).toBe(true)
  })
})

describe('selecting from a set', () => {
  const versions = [v('1.5.7'), v('1.6.0-rc1'), v('1.6.0'), v('0.12.31'), v('1.6.1-beta')]

  it('picks the highest final release', () => {
    expect(latestFinalVersion(versions)?.toString()).toBe('1.6.0')
  })

  it('picks the highest version overall when pre-releases count', () => {
    expect(latestVersion(versions)?.toString()).toBe('1.6.1-beta')
  })

  it('picks the lowest final release', () => {
    expect(earliestFinalVersion(versions)?.toString()).toBe('0.12.31')
  })

  it('returns undefined when every candidate is a pre-release', () => {
    expect(latestFinalVersion([v('1.6.0-rc1'), v('1.6.0-rc2')])).toBeUndefined()
  })

  it('returns undefined for an empty set', () => {
    expect(latestFinalVersion([])).toBeUndefined()
    expect(latestVersion([])).toBeUndefined()
  })
})
