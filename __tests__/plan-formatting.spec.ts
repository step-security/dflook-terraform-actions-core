import { readFileSync } from 'fs'
import { join } from 'path'
import {
  formatDiff,
  formatPlanText,
  planHighlighting,
  truncate,
} from '../src/comment/plan-formatting.js'

const FIXTURES = join(__dirname, 'fixtures', 'plan-format')

/**
 * The expectation was produced by running upstream's own `format_diff`, not
 * written by hand. See the fixtures README.
 */
describe('parity with upstream diff formatting', () => {
  it('matches on a realistic plan', () => {
    const input = readFileSync(join(FIXTURES, 'plan.txt'), 'utf8')
    const expected = readFileSync(join(FIXTURES, 'plan.diff.txt'), 'utf8')

    expect(formatDiff(input)).toBe(expected)
  })
})

describe('moving the operation marker', () => {
  it('moves a create marker to column zero', () => {
    expect(formatDiff('  + resource "a" "b" {')).toBe('+   resource "a" "b" {')
  })

  it('moves a destroy marker', () => {
    expect(formatDiff('  - resource "a" "b" {')).toBe('-   resource "a" "b" {')
  })

  /** GitHub does not colour `~`, but it does colour `!`. */
  it('turns a change marker into one GitHub colours', () => {
    expect(formatDiff('  ~ resource "a" "b" {')).toBe('!~  resource "a" "b" {')
  })

  it('preserves the original indentation after the marker', () => {
    expect(formatDiff('      + ami = "x"')).toBe('+       ami = "x"')
  })

  it('rewrites the hidden attribute comment', () => {
    expect(formatDiff('      # (3 unchanged attributes hidden)')).toBe(
      '#      (3 unchanged attributes hidden)'
    )
  })

  it('leaves an unmarked line alone', () => {
    expect(formatDiff('Plan: 1 to add, 0 to change, 0 to destroy.')).toBe(
      'Plan: 1 to add, 0 to change, 0 to destroy.'
    )
  })

  it('leaves a blank line alone', () => {
    expect(formatDiff('')).toBe('')
  })
})

/**
 * A heredoc can hold anything, including a shell script whose lines start with
 * `-` or `+`. Rewriting those would corrupt the value being displayed.
 */
describe('heredoc bodies', () => {
  it('passes the body through untouched', () => {
    const plan = ['      ~ script = <<-EOT', '        - not a deletion', '        EOT'].join('\n')
    expect(formatDiff(plan)).toContain('        - not a deletion')
  })

  it('resumes rewriting after the heredoc ends', () => {
    const plan = [
      '      ~ script = <<-EOT',
      '        - inside',
      '        EOT',
      '      + after = "x"',
    ].join('\n')

    const formatted = formatDiff(plan).split('\n')
    expect(formatted[1]).toBe('        - inside')
    expect(formatted[3]).toBe('+       after = "x"')
  })

  it('handles an unterminated heredoc without losing the rest', () => {
    const plan = ['      ~ script = <<-EOT', '        - inside', '        - still inside'].join('\n')
    expect(formatDiff(plan).split('\n')).toHaveLength(3)
  })
})

/**
 * The limit is in bytes, which is what a comment body is measured in. Counting
 * characters would cut a plan full of multi-byte text too late.
 */
describe('truncating', () => {
  it('keeps text under the limit intact', () => {
    expect(truncate('short', 1000, 'too big')).toBe('short')
  })

  it('cuts on a line boundary and appends the message', () => {
    const text = ['aaaa', 'bbbb', 'cccc'].join('\n')
    const result = truncate(text, 11, 'too big')
    expect(result).toBe('aaaa\nbbbb\ntoo big')
  })

  it('counts bytes rather than characters', () => {
    // Four astral characters: 4 chars, 16 bytes.
    const text = '🔑🔑🔑🔑\nsecond line'
    expect(truncate(text, 10, 'too big')).toBe('too big')
  })
})

describe('choosing a format', () => {
  it('renders as a diff by default', () => {
    expect(formatPlanText('  + resource "a" "b" {}').format).toBe('diff')
  })

  it('leaves text alone when asked for text', () => {
    const plan = '  + resource "a" "b" {}'
    expect(formatPlanText(plan, 'text')).toEqual({ format: 'text', text: plan })
  })

  it('reports truncation in the format', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `  + line_${i} = "value"`).join('\n')
    expect(formatPlanText(huge).format).toBe('diff-trunc')
  })

  it('reports truncation for plain text too', () => {
    const huge = 'x'.repeat(60_000)
    expect(formatPlanText(huge, 'text').format).toBe('trunc')
  })

  it('says where the full plan is when truncating', () => {
    const huge = 'x\n'.repeat(40_000)
    expect(formatPlanText(huge, 'text').text).toContain('See the full plan in the workflow log')
  })
})

describe('syntax highlighting', () => {
  it('uses diff for a diff-formatted plan', () => {
    expect(planHighlighting('diff', true)).toBe('diff')
    expect(planHighlighting('diff-trunc', true)).toBe('diff')
  })

  it('uses hcl for plain text', () => {
    expect(planHighlighting('text', true)).toBe('hcl')
  })

  /** Nothing to colour when the plan makes no changes. */
  it('uses none when there are no changes', () => {
    expect(planHighlighting('diff', false)).toBe('')
    expect(planHighlighting('text', false)).toBe('')
  })
})
/**
 * Plan text is arbitrarily long, so these must not depend on output size.
 */
describe('formatting cost', () => {
  it.each([
    ['a long run of spaces', ' '.repeat(80_000)],
    ['a long run of digits', `Plan: ${'9'.repeat(80_000)}`],
    ['many near-miss comment lines', '      # (unchanged\n'.repeat(20_000)],
  ])('handles %s promptly', (_label, input) => {
    const started = Date.now()
    formatDiff(input)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
