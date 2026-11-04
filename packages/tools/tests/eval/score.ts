import { countTerms } from '../../src/normalization/term-tagger.js'
import type { Glossary } from '../../src/normalization/term-tagger.js'
import { lintLineParity } from '../../src/verification/line-parity-linter.js'
import {
  checkTermConsistency,
  checkTranslatedShare,
} from '../../src/verification/stat-proofread.js'

export interface ScoreFinding {
  code: string
  message: string
  line?: number
}

export interface ScoreResult {
  metrics: Record<string, number>
  findings: ScoreFinding[]
}

/** One recorded chapter reply (`recordings/chapter<N>.jsonl`). */
export interface RecordedReply {
  title: string
  paragraphs: string[]
}

export interface ScoreOptions {
  /** Share of expected recording slots that could not be parsed (0..1). */
  parseFailureRate?: number
}

/** Allowed range for one baseline metric. `target ± tolerance` is also accepted. */
export interface MetricTolerance {
  min?: number
  max?: number
  target?: number
  tolerance?: number
}

export type BaselineTolerances = Record<string, MetricTolerance>

export interface MetricViolation {
  metric: string
  value: number
  min?: number
  max?: number
  message: string
}

export interface MetricRow {
  label: string
  metrics: Record<string, number>
}

/** Raised when a canned reply is not a JSON object with a title and paragraph array. */
export class RecordingParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecordingParseError'
  }
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Number of paragraph slots the source fixture expects (non-empty lines after the heading). */
export function expectedParagraphSlots(en: string): number {
  let headingDone = false
  let slots = 0
  for (const line of en.split('\n')) {
    if (line.trim() === '') continue
    if (!headingDone && /^#\s+/.test(line)) {
      headingDone = true
      continue
    }
    slots++
  }
  return slots
}

/** Parse one recorded reply; accepts a single JSON object (JSONL files hold one object). */
export function parseRecording(raw: string): RecordedReply {
  const text = raw.trim()
  if (text === '') throw new RecordingParseError('recording is empty')

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new RecordingParseError(`recording is not valid JSON: ${errorMessage(error)}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new RecordingParseError('recording must be a JSON object')
  }

  const record = data as Record<string, unknown>
  if (typeof record.title !== 'string' || record.title.trim() === '') {
    throw new RecordingParseError('recording.title must be a non-empty string')
  }
  if (!Array.isArray(record.paragraphs)) {
    throw new RecordingParseError('recording.paragraphs must be an array')
  }

  const paragraphs = record.paragraphs.map((paragraph, index) => {
    if (typeof paragraph !== 'string') {
      throw new RecordingParseError(`recording.paragraphs[${index}] must be a string`)
    }
    return paragraph.trim()
  })
  return { title: record.title.trim(), paragraphs }
}

/** Rebuild a chapter translation from its recorded title + paragraph slots. */
export function renderRecording(reply: RecordedReply): string {
  const lines = [`# ${reply.title}`]
  for (const paragraph of reply.paragraphs) lines.push('', paragraph)
  return lines.join('\n')
}

/**
 * Score one produced translation with the existing verification tools.
 *
 * Pure: no filesystem, network, or model access. `findings` carries the measured issues;
 * `metrics` is the gate surface consumed by {@link compareToBaseline}.
 */
export function scoreChapter(
  en: string,
  ru: string,
  glossary?: Glossary,
  options: ScoreOptions = {},
): ScoreResult {
  const parity = lintLineParity(en, ru)
  const termIssues = checkTermConsistency(ru, glossary)
  const share = checkTranslatedShare(ru)
  const expectedTerms = glossary ? countTerms(en, glossary).size : 0
  const termConsistency =
    expectedTerms === 0 ? 1 : Math.max(0, 1 - termIssues.length / expectedTerms)
  const enLines = en === '' ? 0 : en.split('\n').length
  const ruLines = ru === '' ? 0 : ru.split('\n').length

  const metrics: Record<string, number> = {
    parityErrors: parity.errors,
    parityWarnings: parity.warnings,
    cyrillicRatio: share.cyrillicShare,
    termConsistency: round6(termConsistency),
    termConsistencyIssues: termIssues.length,
    untranslatedShare: share.untranslatedShare,
    lengthRatioChars: en.length === 0 ? 0 : round6(ru.length / en.length),
    lengthRatioLines: enLines === 0 ? 0 : round6(ruLines / enLines),
    parseFailureRate: round6(options.parseFailureRate ?? 0),
  }

  const findings: ScoreFinding[] = parity.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    ...(issue.line !== undefined ? { line: issue.line } : {}),
  }))
  for (const issue of termIssues) {
    findings.push({ code: 'term-consistency', message: issue.detail })
  }
  for (const issue of share.issues) {
    findings.push({ code: issue.kind, message: issue.detail })
  }

  return { metrics, findings }
}

/** Score a canned recording against the source fixture; records missing/extra/blank slots. */
export function scoreRecording(en: string, raw: string, glossary?: Glossary): ScoreResult {
  const expected = expectedParagraphSlots(en)
  const findings: ScoreFinding[] = []
  let reply: RecordedReply | undefined
  let parseFailureRate = 0

  try {
    reply = parseRecording(raw)
  } catch (error) {
    parseFailureRate = 1
    findings.push({ code: 'recording-parse', message: errorMessage(error) })
  }

  if (reply) {
    const actual = reply.paragraphs.length
    const missing = Math.max(0, expected - actual)
    const extra = Math.max(0, actual - expected)
    const blank = reply.paragraphs.filter((paragraph) => paragraph === '').length
    const failed = missing + extra + blank
    parseFailureRate =
      expected === 0 ? (failed > 0 ? 1 : 0) : round6(Math.min(1, failed / expected))

    if (missing > 0) {
      findings.push({
        code: 'recording-slots-missing',
        message: `recording has ${actual} paragraph slots, expected ${expected} (${missing} missing)`,
      })
    }
    if (extra > 0) {
      findings.push({
        code: 'recording-slots-extra',
        message: `recording has ${actual} paragraph slots, expected ${expected} (${extra} extra)`,
      })
    }
    if (blank > 0) {
      findings.push({
        code: 'recording-slot-blank',
        message: `recording has ${blank} blank paragraph slot(s)`,
      })
    }
  }

  const scored = scoreChapter(en, reply ? renderRecording(reply) : '', glossary, {
    parseFailureRate,
  })
  return { metrics: scored.metrics, findings: [...findings, ...scored.findings] }
}

function bounds(tolerance: MetricTolerance): { min?: number; max?: number } {
  if (tolerance.target !== undefined && tolerance.tolerance !== undefined) {
    return {
      min: tolerance.target - tolerance.tolerance,
      max: tolerance.target + tolerance.tolerance,
    }
  }
  return {
    ...(tolerance.min !== undefined ? { min: tolerance.min } : {}),
    ...(tolerance.max !== undefined ? { max: tolerance.max } : {}),
  }
}

/**
 * Compare every measured metric with its tolerance. A missing tolerance is a violation so a
 * newly added metric cannot silently escape the gate.
 */
export function compareToBaseline(
  metrics: Record<string, number>,
  tolerances: BaselineTolerances,
): MetricViolation[] {
  const violations: MetricViolation[] = []
  for (const [metric, value] of Object.entries(metrics)) {
    const tolerance = tolerances[metric]
    if (!tolerance) {
      violations.push({ metric, value, message: `${metric} has no baseline tolerance` })
      continue
    }
    const { min, max } = bounds(tolerance)
    if (min !== undefined && value < min) {
      violations.push({
        metric,
        value,
        min,
        ...(max !== undefined ? { max } : {}),
        message: `${metric} ${value} below baseline min ${min}`,
      })
    }
    if (max !== undefined && value > max) {
      violations.push({
        metric,
        value,
        ...(min !== undefined ? { min } : {}),
        max,
        message: `${metric} ${value} above baseline max ${max}`,
      })
    }
  }
  return violations
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4)
}

/** Plain-text metric table (printed by the offline eval run). */
export function formatMetricTable(rows: readonly MetricRow[]): string {
  if (rows.length === 0) return '(no eval rows)'
  const keys = Object.keys(rows[0]?.metrics ?? {})
  for (const row of rows) {
    for (const key of Object.keys(row.metrics)) {
      if (!keys.includes(key)) keys.push(key)
    }
  }

  const header = ['metric', ...rows.map((row) => row.label)]
  const body = keys.map((key) => [key, ...rows.map((row) => formatValue(row.metrics[key] ?? 0))])
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...body.map((row) => row[column]?.length ?? 0)),
  )
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
      .join('  ')
      .trimEnd()
  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...body.map(line)].join(
    '\n',
  )
}
