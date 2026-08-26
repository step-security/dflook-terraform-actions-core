/**
 * Redacting sensitive values from plan and apply output.
 *
 * Plan output is written to the job log and, for some actions, to a pull request
 * comment. Terraform prints attribute values in full there, so anything that
 * looks like a credential has to be masked before it is published.
 *
 * The rules match the `tfmask` tool that upstream pipes its output through, so
 * that output redacted there stays redacted here. Two properties of those rules
 * are worth knowing because they look like bugs otherwise:
 *
 * - Masking is driven by the *attribute name*, not by Terraform's own
 *   `sensitive` marking. `password` is masked; a variable marked sensitive but
 *   called `config` is not. This is a coarse net, deliberately.
 * - Values that merely state the absence of a value are left alone, so a plan
 *   still reads as a plan rather than a wall of asterisks.
 *
 * It is a filter over already-rendered text, not a parser, so it cannot be
 * relied on as the only defence for a secret.
 */

/** Values that describe the absence of a value, so masking them tells nobody anything. */
const NOT_A_VALUE = ['sensitive', 'computed', '<computed', 'known after apply']

/** Attribute names whose values are masked. */
export const DEFAULT_VALUES_PATTERN = '(?i)^.*[^a-zA-Z](oauth|secret|token|password|key|result|id).*$'

/**
 * Resources whose ids are masked wholesale.
 *
 * Wider than the tool's own default, matching the value upstream sets: these
 * resource types exist to hold generated secrets, so their ids are secrets.
 */
export const DEFAULT_RESOURCES_PATTERN =
  '(?i)^(random_id|kubernetes_secret|acme_certificate).*$'

export interface MaskOptions {
  /** Character repeated to replace a value. */
  maskChar?: string
  /** Attribute names to mask, as a Go-style pattern. */
  valuesPattern?: string
  /** Resource types whose ids to mask, as a Go-style pattern. */
  resourcesPattern?: string
  /** Output dialect: Terraform 0.12 and later, or 0.11. */
  dialect?: '0.11' | '0.12'
}

/**
 * Compiles a Go-style pattern for use here.
 *
 * Go supports `(?i)` as an inline flag; JavaScript has no inline flags at all
 * and rejects the sequence outright. Since these patterns are user-overridable
 * through the environment, the flag is lifted out to the regex flags rather than
 * left to throw. Lifting is not a faithful translation when the flag appears
 * part-way through a pattern — Go would apply it only from that point — but it
 * errs towards masking more, which is the safe direction.
 */
function compile(pattern: string): RegExp {
  const caseInsensitive = pattern.includes('(?i)')
  const cleaned = pattern.split('(?i)').join('')
  return new RegExp(cleaned, caseInsensitive ? 'i' : '')
}

interface Dialect {
  planStatus: RegExp
  planLine: RegExp
  currentResource: RegExp
  mapKeyPair: RegExp
  /** Capture group in `currentResource` holding the resource address. */
  resourceGroup: number
  assign: string
  operator: string
}

const DIALECTS: Record<'0.11' | '0.12', Dialect> = {
  '0.11': {
    planStatus: /^(.*?): (.*?) +\(ID: (.*?)\)$/,
    planLine: /^( +)([a-zA-Z0-9%._-]+):( +)(["<])(.*?)([>"]) +=> +(["<])(.*)([>"])(.*)$/,
    currentResource: /^([~/+-]+) (.*?) +(.*)$/,
    mapKeyPair: /^(\s+(?:[~+-] )?)(.*)(\s?[=:])(\s+)"(.*)"$/i,
    resourceGroup: 2,
    assign: ':',
    operator: '=>',
  },
  '0.12': {
    planStatus: /^(.*?): (.*?) +\[id=(.*?)\]$/,
    planLine: /^( +)([ ~a-zA-Z0-9%._-]+)=( +)(["<])(.*?)([>"]) +-> +(\()(.*)(\))(.*)$/,
    currentResource: /^([~/+-]+) (.*?) +(.*) (.*) (.*)$/,
    mapKeyPair: /^(\s+(?:[~+-] )?)(.*)(\s=)(\s+)"(.*)"$/i,
    resourceGroup: 3,
    assign: '=',
    operator: '->',
  },
}

/** Set when a line names the resource that following lines belong to. */
const APPLY_CURRENT_RESOURCE = /^([a-z].*?): (.*?)$/

function maskValue(value: string, maskChar: string): string {
  if (NOT_A_VALUE.includes(value)) return value
  // Count code points, not UTF-16 units, so an astral character contributes one
  // mask character rather than two and the value's length is not misreported.
  return maskChar.repeat([...value].length)
}

/** Replaces the first occurrence only, as Go's strings.Replace with n=1 does. */
function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const at = haystack.indexOf(needle)
  if (at === -1) return haystack
  return haystack.slice(0, at) + replacement + haystack.slice(at + needle.length)
}

/**
 * Masks sensitive values in one stream of Terraform output.
 *
 * Stateful across lines: a resource named on one line governs how the lines
 * beneath it are treated, so this has to see the output in order.
 */
export class Masker {
  private readonly maskChar: string
  private readonly values: RegExp
  private readonly resources: RegExp
  private readonly dialect: Dialect
  private currentResource = ''

  constructor(options: MaskOptions = {}) {
    this.maskChar = options.maskChar ?? '*'
    this.values = compile(options.valuesPattern ?? DEFAULT_VALUES_PATTERN)
    this.resources = compile(options.resourcesPattern ?? DEFAULT_RESOURCES_PATTERN)
    this.dialect = DIALECTS[options.dialect ?? '0.12']
  }

  /** Masks a single line, updating which resource is in scope. */
  line(line: string): string {
    this.track(line)

    if (this.dialect.planStatus.test(line)) return this.maskStatus(line)
    if (this.dialect.planLine.test(line)) return this.maskPlanLine(line)
    if (this.dialect.mapKeyPair.test(line)) return this.maskAssignment(line)
    return line
  }

  /** Masks a whole block of output, preserving the trailing newline if present. */
  text(output: string): string {
    const trailing = output.endsWith('\n')
    const body = trailing ? output.slice(0, -1) : output
    const masked = body.split('\n').map((line) => this.line(line))
    return trailing ? `${masked.join('\n')}\n` : masked.join('\n')
  }

  private track(line: string): void {
    const inPlan = this.dialect.currentResource.exec(line)
    if (inPlan) {
      // Terraform 0.12 quotes the resource type and name; the address does not
      // include the quotes.
      this.currentResource = (inPlan[this.dialect.resourceGroup] ?? '').split('"').join('')
      return
    }

    const inApply = APPLY_CURRENT_RESOURCE.exec(line)
    if (inApply) this.currentResource = inApply[1] ?? ''
  }

  /** `resource.name: Creating... [id=secret]` — mask the id of a secret-bearing resource. */
  private maskStatus(line: string): string {
    const match = this.dialect.planStatus.exec(line)
    if (!match) return line

    const resource = match[1] ?? ''
    const id = match[3] ?? ''
    if (!this.resources.test(resource)) return line

    return replaceFirst(line, id, this.maskChar.repeat([...id].length))
  }

  /** `~ attribute = "before" -> (after)` — mask both sides of a change. */
  private maskPlanLine(line: string): string {
    const match = this.dialect.planLine.exec(line)
    if (!match) return line

    const [
      ,
      leading = '',
      property = '',
      trailing = '',
      firstQuote = '',
      oldValue = '',
      secondQuote = '',
      thirdQuote = '',
      newValue = '',
      fourthQuote = '',
      postfix = '',
    ] = match

    // Either the attribute looks sensitive, or the whole resource is.
    if (!this.values.test(property) && !this.resources.test(this.currentResource)) return line

    const before = maskValue(oldValue, this.maskChar)
    const after = maskValue(newValue, this.maskChar)
    const { assign, operator } = this.dialect

    return (
      `${leading}${property}${assign}${trailing}${firstQuote}${before}${secondQuote}` +
      ` ${operator} ${thirdQuote}${after}${fourthQuote}${postfix}`
    )
  }

  /** `attribute = "value"` — mask a plain assignment. */
  private maskAssignment(line: string): string {
    const match = this.dialect.mapKeyPair.exec(line)
    if (!match) return line

    const [, leading = '', property = '', operator = '', spacing = '', value = ''] = match
    if (!this.values.test(property)) return line

    return `${leading}${property}${operator}${spacing}"${maskValue(value, this.maskChar)}"`
  }
}

/** Masks a block of output with the default rules. */
export function maskOutput(output: string, options: MaskOptions = {}): string {
  return new Masker(options).text(output)
}

/**
 * Builds mask options from the environment.
 *
 * The same variable names the underlying tool reads, so a workflow that
 * customises them against upstream keeps working.
 */
export function maskOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): MaskOptions {
  const dialect = env.TFENV === '0.11' ? '0.11' : '0.12'
  return {
    maskChar: env.TFMASK_CHAR || '*',
    valuesPattern: env.TFMASK_VALUES_REGEX || DEFAULT_VALUES_PATTERN,
    resourcesPattern: env.TFMASK_RESOURCES_REGEX || DEFAULT_RESOURCES_PATTERN,
    dialect,
  }
}
