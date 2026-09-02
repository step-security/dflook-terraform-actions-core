import {
  ValidateReportError,
  formatAnnotation,
  isValid,
  parseValidateReport,
  validateAnnotations,
} from '../src/terraform/validate.js'

/** The shape `terraform validate -json` actually produces. */
const REPORT = {
  format_version: '1.0',
  valid: false,
  error_count: 1,
  warning_count: 1,
  diagnostics: [
    {
      severity: 'error',
      summary: 'Unsupported argument',
      detail: 'An argument named "instance_typo" is not expected here.',
      range: {
        filename: 'main.tf',
        start: { line: 12, column: 3, byte: 200 },
        end: { line: 12, column: 16, byte: 213 },
      },
    },
    {
      severity: 'warning',
      summary: 'Deprecated attribute',
      range: {
        filename: 'modules/net/main.tf',
        start: { line: 4, column: 1, byte: 40 },
        end: { line: 7, column: 2, byte: 90 },
      },
    },
  ],
}

describe('parsing the report', () => {
  it('reads a valid report', () => {
    expect(parseValidateReport(JSON.stringify({ valid: true, diagnostics: [] })).valid).toBe(true)
  })

  /**
   * "No diagnostics" and "could not tell" must lead to different behaviour: the
   * caller falls back to plain validate so the user sees something.
   */
  it('fails on unparseable output', () => {
    expect(() => parseValidateReport('not json at all')).toThrow(ValidateReportError)
  })

  it('fails on a JSON array', () => {
    expect(() => parseValidateReport('[]')).toThrow(ValidateReportError)
  })

  it('treats a missing valid field as not valid', () => {
    expect(isValid(parseValidateReport('{}'))).toBe(false)
  })

  it('reads valid true', () => {
    expect(isValid({ valid: true })).toBe(true)
  })
})

describe('building annotations', () => {
  it('makes one per diagnostic', () => {
    expect(validateAnnotations(REPORT, 'infra')).toHaveLength(2)
  })

  it('carries the severity through', () => {
    const [error, warning] = validateAnnotations(REPORT, 'infra')
    expect(error.severity).toBe('error')
    expect(warning.severity).toBe('warning')
  })

  it('uses only the first line of the summary', () => {
    const report = {
      diagnostics: [{ severity: 'error', summary: 'First line\nSecond line' }],
    }
    expect(validateAnnotations(report, '.')[0].message).toBe('First line')
  })

  /** Terraform reports paths relative to where it ran; an annotation needs one
   * relative to the repository. */
  it('resolves the filename against the module', () => {
    expect(validateAnnotations(REPORT, 'infra')[0].file).toBe('infra/main.tf')
  })

  it('normalises the resolved path', () => {
    const report = { diagnostics: [{ severity: 'error', summary: 'x', range: { filename: 'a.tf' } }] }
    expect(validateAnnotations(report, './infra/')[0].file).toBe('infra/a.tf')
  })

  it('handles the module being the workspace root', () => {
    expect(validateAnnotations(REPORT, '.')[0].file).toBe('main.tf')
  })

  it('omits position when the diagnostic has no range', () => {
    const report = { diagnostics: [{ severity: 'error', summary: 'Something broad' }] }
    const [annotation] = validateAnnotations(report, '.')
    expect(annotation.file).toBeUndefined()
    expect(annotation.line).toBeUndefined()
  })
})

/**
 * GitHub rejects a column range spanning several lines, and drops the whole
 * annotation rather than just the columns. Losing the column is better than
 * losing the diagnostic.
 */
describe('a diagnostic spanning several lines', () => {
  it('keeps the line range and drops the columns', () => {
    const [, warning] = validateAnnotations(REPORT, 'infra')

    expect(warning.line).toBe(4)
    expect(warning.endLine).toBe(7)
    expect(warning.col).toBeUndefined()
    expect(warning.endColumn).toBeUndefined()
  })

  it('keeps the columns when it is one line', () => {
    const [error] = validateAnnotations(REPORT, 'infra')

    expect(error.line).toBe(12)
    expect(error.endLine).toBe(12)
    expect(error.col).toBe(3)
    expect(error.endColumn).toBe(16)
  })
})

/**
 * Validation runs after an init that is allowed to fail, so an uninstalled
 * module is usually a downstream effect of a real error reported elsewhere.
 */
describe('diagnostics that say nothing useful', () => {
  it('drops Module not installed', () => {
    const report = {
      diagnostics: [
        { severity: 'error', summary: 'Module not installed' },
        { severity: 'error', summary: 'Unsupported argument' },
      ],
    }

    const annotations = validateAnnotations(report, '.')
    expect(annotations).toHaveLength(1)
    expect(annotations[0].message).toBe('Unsupported argument')
  })

  it('keeps a diagnostic that merely mentions modules', () => {
    const report = { diagnostics: [{ severity: 'error', summary: 'Module not found upstream' }] }
    expect(validateAnnotations(report, '.')).toHaveLength(1)
  })
})

describe('rendering a workflow command', () => {
  it('renders a full position', () => {
    expect(formatAnnotation(validateAnnotations(REPORT, 'infra')[0])).toBe(
      '::error file=infra/main.tf,line=12,col=3,endLine=12,endColumn=16::Unsupported argument'
    )
  })

  it('renders a multi-line range without columns', () => {
    expect(formatAnnotation(validateAnnotations(REPORT, 'infra')[1])).toBe(
      '::warning file=infra/modules/net/main.tf,line=4,endLine=7::Deprecated attribute'
    )
  })

  it('renders a diagnostic with no position', () => {
    const report = { diagnostics: [{ severity: 'error', summary: 'Broad problem' }] }
    expect(formatAnnotation(validateAnnotations(report, '.')[0])).toBe('::error ::Broad problem')
  })

  it('defaults an absent severity to error', () => {
    const report = { diagnostics: [{ summary: 'No severity given' }] }
    expect(validateAnnotations(report, '.')[0].severity).toBe('error')
  })
})

describe('an empty report', () => {
  it('produces no annotations', () => {
    expect(validateAnnotations({ valid: true }, '.')).toEqual([])
    expect(validateAnnotations({ valid: true, diagnostics: [] }, '.')).toEqual([])
  })
})