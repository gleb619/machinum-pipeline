import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Glossary } from '../../src/normalization/term-tagger.js'
import { compareToBaseline, formatMetricTable, parseRecording, scoreRecording } from './score.js'
import type { BaselineTolerances, MetricRow, ScoreResult } from './score.js'

const evalDir = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(evalDir, 'fixtures')
const recordingsDir = join(evalDir, 'recordings')

interface Baseline {
  tolerances: BaselineTolerances
  recorded: Record<string, Record<string, number>>
}

interface EvalCase {
  label: string
  en: string
  raw: string
  result: ScoreResult
}

function readBaseline(): Baseline {
  return JSON.parse(readFileSync(join(evalDir, 'baseline.json'), 'utf-8')) as Baseline
}

function readGlossary(): Glossary {
  return JSON.parse(readFileSync(join(fixturesDir, 'glossary.json'), 'utf-8')) as Glossary
}

function loadCases(): EvalCase[] {
  const glossary = readGlossary()
  return [1, 2, 3].map((chapter) => {
    const label = `chapter${chapter}`
    const en = readFileSync(join(fixturesDir, `${label}.md`), 'utf-8').trim()
    const raw = readFileSync(join(recordingsDir, `${label}.jsonl`), 'utf-8')
    return { label, en, raw, result: scoreRecording(en, raw, glossary) }
  })
}

function violationMessages(cases: readonly EvalCase[], baseline: Baseline): string[] {
  return cases.flatMap((testCase) =>
    compareToBaseline(testCase.result.metrics, baseline.tolerances).map(
      (violation) => `${testCase.label}: ${violation.message}`,
    ),
  )
}

function sourceParagraph(en: string, index: number): string {
  return en.split('\n').filter((line) => line.trim() !== '')[index] ?? ''
}

describe('translation eval harness', () => {
  it('prints the metric table', () => {
    const rows: MetricRow[] = loadCases().map((testCase) => ({
      label: testCase.label,
      metrics: testCase.result.metrics,
    }))
    process.stdout.write(`\n${formatMetricTable(rows)}\n`)
    expect(rows).toHaveLength(3)
  })

  it('offline recordings stay within every baseline tolerance', () => {
    const baseline = readBaseline()
    const cases = loadCases()
    expect(violationMessages(cases, baseline)).toEqual([])
  })

  it('every scored metric has a committed baseline tolerance', () => {
    const baseline = readBaseline()
    for (const testCase of loadCases()) {
      for (const metric of Object.keys(testCase.result.metrics)) {
        expect(baseline.tolerances, `${testCase.label}/${metric}`).toHaveProperty(metric)
      }
    }
  })

  it('rejects a dropped paragraph and names the offending metrics', () => {
    const baseline = readBaseline()
    const testCase = loadCases()[0]
    expect(testCase).toBeDefined()
    if (!testCase) return

    const recording = parseRecording(testCase.raw)
    recording.paragraphs.pop()
    const degraded = scoreRecording(testCase.en, JSON.stringify(recording), readGlossary())
    const violations = compareToBaseline(degraded.metrics, baseline.tolerances)
    const names = violations.map((violation) => violation.metric)

    expect(names).toContain('parityErrors')
    expect(names).toContain('parseFailureRate')
    expect(violations.map((violation) => violation.message).join('\n')).toMatch(/parityErrors/)
  })

  it('rejects an untranslated paragraph and names the offending metrics', () => {
    const baseline = readBaseline()
    const testCase = loadCases()[0]
    expect(testCase).toBeDefined()
    if (!testCase) return

    const recording = parseRecording(testCase.raw)
    recording.paragraphs[0] = sourceParagraph(testCase.en, 1)
    const degraded = scoreRecording(testCase.en, JSON.stringify(recording), readGlossary())
    const violations = compareToBaseline(degraded.metrics, baseline.tolerances)
    const names = violations.map((violation) => violation.metric)

    expect(names).toContain('untranslatedShare')
    expect(names).toContain('termConsistency')
    expect(violations.map((violation) => violation.message).join('\n')).toMatch(
      /untranslatedShare|termConsistency/,
    )
  })

  it('reports malformed recordings as a full parse failure', () => {
    const testCase = loadCases()[0]
    expect(testCase).toBeDefined()
    if (!testCase) return

    const broken = scoreRecording(testCase.en, '{"title":', readGlossary())
    expect(broken.metrics.parseFailureRate).toBe(1)
    expect(broken.findings.some((finding) => finding.code === 'recording-parse')).toBe(true)
  })
})
