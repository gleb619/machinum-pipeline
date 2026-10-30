import { defineTool, setVariable } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'

/** Severity of a parity issue: `error` fails the check, `warn` is informational. */
export type ParitySeverity = 'error' | 'warn'

export type ParityIssueCode =
  | 'line-count'
  | 'empty-line-position'
  | 'bracket-line-position'
  | 'low-cyrillic'
  | 'untranslated-line'
  | 'term-tag-left'
  | 'think-block'
  | 'low-cyrillic-accepted'

/** One finding. `line` is 1-based and refers to the RU text (or EN when RU has no such line). */
export interface ParityIssue {
  code: ParityIssueCode
  severity: ParitySeverity
  message: string
  line?: number
}

export interface LineParityOptions {
  /** Minimum share of Cyrillic letters among all letters of the RU text. Default 0.3. */
  minCyrillicRatio?: number
  /** Severity of the chapter-level Cyrillic ratio check. Default `error`. */
  cyrillicSeverity?: ParitySeverity
  /** Minimum EN letters on a line before a Cyrillic-free RU line is flagged. Default 20. */
  untranslatedMinLetters?: number
}

export interface LineParityReport {
  /** `true` when there is no `error` issue. */
  ok: boolean
  enLines: number
  ruLines: number
  errors: number
  warnings: number
  cyrillicRatio: number
  /** True when the share check was accepted via the stability escape hatch. */
  escapeHatch?: boolean
  issues: ParityIssue[]
}

export interface LineParityInput {
  en: string
  ru: string
}

const CYRILLIC = /[Ѐ-ӿ]/g
const LETTER = /\p{L}/gu

function count(re: RegExp, s: string): number {
  return s.match(re)?.length ?? 0
}

function isBracketLine(line: string): boolean {
  const t = line.trim()
  return t.length >= 2 && t.startsWith('[') && t.endsWith(']')
}

function positions(lines: string[], pred: (l: string) => boolean): number[] {
  const out: number[] = []
  lines.forEach((l, i) => {
    if (pred(l)) out.push(i + 1)
  })
  return out
}

function firstDiff(a: number[], b: number[]): number | undefined {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] ?? b[i]
  return undefined
}

/**
 * Compare an EN text with its RU translation line by line (pure function).
 *
 * Hard errors: line count, empty-line positions, `[bracketed]` line positions, leftover
 * `<term>` tags, `think` blocks, chapter-level Cyrillic ratio. Warning: single long line
 * without any Cyrillic.
 */
export function lintLineParity(
  en: string,
  ru: string,
  options: LineParityOptions = {},
): LineParityReport {
  const minRatio = options.minCyrillicRatio ?? 0.3
  const ratioSeverity = options.cyrillicSeverity ?? 'error'
  const minLetters = options.untranslatedMinLetters ?? 20
  const enLines = en.split('\n')
  const ruLines = ru.split('\n')
  const issues: ParityIssue[] = []

  if (enLines.length !== ruLines.length) {
    issues.push({
      code: 'line-count',
      severity: 'error',
      message: `line count differs: EN ${enLines.length}, RU ${ruLines.length}`,
    })
  } else {
    const empty = firstDiff(
      positions(enLines, (l) => l.trim() === ''),
      positions(ruLines, (l) => l.trim() === ''),
    )
    if (empty !== undefined) {
      issues.push({
        code: 'empty-line-position',
        severity: 'error',
        message: `empty-line positions differ (first at line ${empty})`,
        line: empty,
      })
    }
  }

  const bracket = firstDiff(positions(enLines, isBracketLine), positions(ruLines, isBracketLine))
  if (bracket !== undefined) {
    issues.push({
      code: 'bracket-line-position',
      severity: 'error',
      message: `[bracketed] line positions differ (first at line ${bracket})`,
      line: bracket,
    })
  }

  ruLines.forEach((line, i) => {
    if (/<\/?term\b/i.test(line)) {
      issues.push({
        code: 'term-tag-left',
        severity: 'error',
        message: `leftover <term> tag at line ${i + 1}`,
        line: i + 1,
      })
    }
    if (/<\/?think>/i.test(line)) {
      issues.push({
        code: 'think-block',
        severity: 'error',
        message: `think block at line ${i + 1}`,
        line: i + 1,
      })
    }
  })

  const ruLetters = count(LETTER, ru)
  const ratio = ruLetters === 0 ? 0 : count(CYRILLIC, ru) / ruLetters
  if (count(LETTER, en) > 0 && ratio < minRatio) {
    issues.push({
      code: 'low-cyrillic',
      severity: ratioSeverity,
      message: `Cyrillic ratio ${ratio.toFixed(2)} below ${minRatio}`,
    })
  }

  if (enLines.length === ruLines.length) {
    enLines.forEach((line, i) => {
      const ruLine = ruLines[i] ?? ''
      if (count(LETTER, line) >= minLetters && count(CYRILLIC, ruLine) === 0) {
        issues.push({
          code: 'untranslated-line',
          severity: 'warn',
          message: `line ${i + 1} has no Cyrillic`,
          line: i + 1,
        })
      }
    })
  }

  const errors = issues.filter((x) => x.severity === 'error').length
  return {
    ok: errors === 0,
    enLines: enLines.length,
    ruLines: ruLines.length,
    errors,
    warnings: issues.length - errors,
    cyrillicRatio: Math.round(ratio * 1000) / 1000,
    issues,
  }
}

/** Thrown by {@link lineParityLinter} on a hard error; `retryable` so the engine retries. */
export class LineParityError extends Error {
  readonly retryable = true
  /** Measured feedback (see {@link parityFeedback}) for retry-prompt injection. */
  readonly feedback: string
  constructor(
    readonly report: LineParityReport,
    readonly where?: string,
  ) {
    const first = report.issues.filter((i) => i.severity === 'error').map((i) => i.message)
    super(
      `line parity check failed${where ? ` at ${where}` : ''} (${report.errors} error(s)): ${first.slice(0, 3).join('; ')}`,
    )
    this.name = 'LineParityError'
    this.feedback = parityFeedback(report)
  }
}

/**
 * Measured, human-readable feedback from a parity report: the numbers a retrying LLM call needs
 * (line counts + delta, Cyrillic ratio) plus the hard-error messages. Throw it from an llm-gate
 * `check` (or read it off {@link LineParityError}) so the retry prompt carries the measurements
 * (ranobe-tl self-correction).
 */
export function parityFeedback(report: LineParityReport): string {
  const parts = [`EN ${report.enLines} lines, RU ${report.ruLines} lines`]
  if (report.enLines !== report.ruLines) {
    parts.push(`line-count delta ${report.ruLines - report.enLines}`)
  }
  parts.push(`Cyrillic ratio ${report.cyrillicRatio}`)
  if (report.escapeHatch) parts.push('accepted by stability escape hatch')
  const errors = report.issues.filter((i) => i.severity === 'error').map((i) => i.message)
  if (errors.length > 0) parts.push(errors.slice(0, 5).join('; '))
  return parts.join('; ')
}

export interface LineParityEscapeHatchOptions {
  /** Absolute tolerance in percentage points (0.005 = 0.5 pp). Default 0.005. */
  absoluteTolerance?: number
  /** Relative tolerance (0.15 = 15%). Default 0.15. */
  relativeTolerance?: number
}

export interface LineParityLinterOptions extends LineParityOptions {
  /** Throw a retryable {@link LineParityError} on hard errors. Default true. */
  throwOnError?: boolean
  /** Enable stability escape hatch for the Cyrillic-ratio check. Default false. */
  escapeHatch?: boolean | LineParityEscapeHatchOptions
}

function normalizeTolerance(v: boolean | LineParityEscapeHatchOptions | undefined): {
  absolute: number
  relative: number
} {
  if (typeof v === 'boolean' || v === undefined) {
    return { absolute: 0.005, relative: 0.15 }
  }
  return {
    absolute: v.absoluteTolerance ?? 0.005,
    relative: v.relativeTolerance ?? 0.15,
  }
}

function isStableShare(
  current: number,
  previous: number,
  tolerance: { absolute: number; relative: number },
): boolean {
  const delta = Math.abs(current - previous)
  if (delta <= tolerance.absolute) return true
  const base = Math.max(current, previous)
  return base > 0 && delta / base <= tolerance.relative
}

function onlyErrorCodes(issues: ParityIssue[], codes: ParityIssueCode[]): boolean {
  return issues.filter((i) => i.severity === 'error').every((i) => codes.includes(i.code))
}

/**
 * Accept a report via the stability escape hatch when the only failing hard check is the
 * chapter-level Cyrillic ratio and the ratio is stable across two attempts.
 */
export function applyLineParityEscapeHatch(
  report: LineParityReport,
  previous: LineParityReport,
  options: boolean | LineParityEscapeHatchOptions = {},
): LineParityReport {
  const tol = normalizeTolerance(options)
  if (report.ok) return report
  if (!onlyErrorCodes(report.issues, ['low-cyrillic'])) return report
  if (previous.ok || !onlyErrorCodes(previous.issues, ['low-cyrillic'])) return report
  if (!isStableShare(report.cyrillicRatio, previous.cyrillicRatio, tol)) return report

  const acceptedIssues = report.issues.map((i) =>
    i.code === 'low-cyrillic'
      ? {
          ...i,
          severity: 'warn' as ParitySeverity,
          message: `${i.message} (accepted by stability escape hatch)`,
        }
      : i,
  )
  acceptedIssues.push({
    code: 'low-cyrillic-accepted',
    severity: 'warn',
    message: `Cyrillic ratio stable at ${report.cyrillicRatio.toFixed(3)}; accepted by escape hatch`,
  })
  const errors = acceptedIssues.filter((i) => i.severity === 'error').length
  return {
    ...report,
    ok: errors === 0,
    errors,
    warnings: acceptedIssues.length - errors,
    escapeHatch: true,
    issues: acceptedIssues,
  }
}

/**
 * Tool factory: `{ en, ru }` in, same item out, `meta.parity` = {@link LineParityReport}.
 * On a hard error it throws a retryable {@link LineParityError} (engine retry), unless
 * `throwOnError: false`.
 *
 * With `escapeHatch` enabled, the linter remembers the previous report for this envelope. If the
 * only hard error is the Cyrillic-ratio check and the ratio is stable across attempts, the chunk
 * is accepted.
 */
export function createLineParityLinter(options: LineParityLinterOptions = {}) {
  const history = new WeakMap<Exchange<LineParityInput>, LineParityReport>()
  return defineTool<LineParityInput, LineParityInput>({
    name: 'line-parity-linter',
    version: '1.0.0',
    mdDescription:
      'Compares EN vs RU: line count, empty/bracket line positions, Cyrillic ratio, leftover <term> tags and think blocks. Report in the parity variable; throws a retryable error on hard errors. Optional stability escape hatch accepts a chunk when only the Cyrillic-ratio check fails and stays stable.',
    async invoke(env, _ctx: ToolContext) {
      const previous = history.get(env)
      const report = lintLineParity(env.item.en, env.item.ru, options)
      history.set(env, report)
      const final =
        previous && options.escapeHatch
          ? applyLineParityEscapeHatch(report, previous, options.escapeHatch)
          : report
      if (!final.ok && options.throwOnError !== false) throw new LineParityError(final)
      return setVariable(env, 'parity', final)
    },
  })
}

export const lineParityLinter = createLineParityLinter()
