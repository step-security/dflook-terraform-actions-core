import { join, normalize } from 'path'

/**
 * Turning a validation report into workflow annotations.
 *
 * `terraform validate -json` reports diagnostics with file positions. Emitting
 * them as workflow commands puts each one on the offending line in the pull
 * request diff, rather than leaving the reader to find it in the log.
 */

export interface Diagnostic {
  severity?: string
  summary?: string
  detail?: string
  range?: {
    filename?: string
    start?: { line?: number; column?: number }
    end?: { line?: number; column?: number }
  }
}

export interface ValidateReport {
  valid?: boolean
  error_count?: number
  warning_count?: number
  diagnostics?: Diagnostic[]
}

export class ValidateReportError extends Error {}

/**
 * Parses `terraform validate -json`.
 *
 * A report that cannot be parsed is an error rather than an empty result,
 * because "no diagnostics" and "could not tell" must lead to different
 * behaviour: the caller falls back to plain `validate` so the user sees
 * something.
 */
export function parseValidateReport(stdout: string): ValidateReport {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new ValidateReportError(
      `Unable to parse the validation report: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidateReportError('Unable to parse the validation report')
  }

  return parsed as ValidateReport
}

/**
 * Diagnostics that say nothing useful on their own.
 *
 * Validation runs after an init that is allowed to fail, so an uninstalled
 * module is usually a downstream effect of a real error reported elsewhere.
 * Surfacing it too would bury the actual cause.
 */
const NOT_WORTH_REPORTING = ['Module not installed']

export interface Annotation {
  severity: string
  file?: string
  line?: number
  col?: number
  endLine?: number
  endColumn?: number
  message: string
}

/**
 * Builds the annotations for a report.
 *
 * Positions are resolved against the module directory, since Terraform reports
 * filenames relative to where it ran and an annotation needs a path relative to
 * the repository.
 */
export function validateAnnotations(report: ValidateReport, basePath: string): Annotation[] {
  const annotations: Annotation[] = []

  for (const diagnostic of report.diagnostics ?? []) {
    // Only the first line: the rest is detail, and a workflow command is a
    // single line.
    const summary = (diagnostic.summary ?? '').split('\n')[0]
    if (NOT_WORTH_REPORTING.includes(summary)) continue

    const annotation: Annotation = {
      severity: diagnostic.severity ?? 'error',
      message: summary,
    }

    const range = diagnostic.range
    if (range) {
      if (range.filename) annotation.file = normalize(join(basePath, range.filename))
      if (range.start) {
        annotation.line = range.start.line
        annotation.col = range.start.column
      }
      if (range.end) {
        annotation.endLine = range.end.line
        annotation.endColumn = range.end.column
      }

      // GitHub rejects a column range that spans several lines, and silently
      // drops the whole annotation rather than the columns. Losing the column
      // is better than losing the diagnostic.
      if (annotation.line !== annotation.endLine) {
        delete annotation.col
        delete annotation.endColumn
      }
    }

    annotations.push(annotation)
  }

  return annotations
}

/** Renders an annotation as a workflow command. */
export function formatAnnotation(annotation: Annotation): string {
  const params: string[] = []

  if (annotation.file !== undefined) params.push(`file=${annotation.file}`)
  if (annotation.line !== undefined) params.push(`line=${annotation.line}`)
  if (annotation.col !== undefined) params.push(`col=${annotation.col}`)
  if (annotation.endLine !== undefined) params.push(`endLine=${annotation.endLine}`)
  if (annotation.endColumn !== undefined) params.push(`endColumn=${annotation.endColumn}`)

  return `::${annotation.severity} ${params.join(',')}::${annotation.message}`
}

/** True when the report says the configuration is valid. */
export function isValid(report: ValidateReport): boolean {
  return report.valid === true
}