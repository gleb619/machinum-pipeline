import { defineTool } from '@mt/core'

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
 * `<term>` tags, `<think>` blocks, chapter-level Cyrillic ratio. Warning: single long line
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
        message: `<think> block at line ${i + 1}`,
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
  constructor(
    readonly report: LineParityReport,
    readonly where?: string,
  ) {
    const first = report.issues.filter((i) => i.severity === 'error').map((i) => i.message)
    super(
      `line parity check failed${where ? ` at ${where}` : ''} (${report.errors} error(s)): ${first.slice(0, 3).join('; ')}`,
    )
    this.name = 'LineParityError'
  }
}

export interface LineParityLinterOptions extends LineParityOptions {
  /** Throw a retryable {@link LineParityError} on hard errors. Default true. */
  throwOnError?: boolean
}

/**
 * Tool factory: `{ en, ru }` in, same item out, `meta.parity` = {@link LineParityReport}.
 * On a hard error it throws a retryable {@link LineParityError} (engine retry), unless
 * `throwOnError: false`.
 */
export function createLineParityLinter(options: LineParityLinterOptions = {}) {
  return defineTool<LineParityInput, LineParityInput>({
    name: 'line-parity-linter',
    version: '1.0.0',
    mdDescription:
      'Compares EN vs RU: line count, empty/bracket line positions, Cyrillic ratio, leftover <term> tags and <think> blocks. Report in meta.parity; throws a retryable error on hard errors.',
    async invoke(env) {
      const report = lintLineParity(env.item.en, env.item.ru, options)
      if (!report.ok && options.throwOnError !== false) throw new LineParityError(report)
      return { item: env.item, meta: { ...env.meta, parity: report } }
    },
  })
}

export const lineParityLinter = createLineParityLinter()
