import { describe, expect, it } from 'vitest'
import type { Glossary } from '../../src/normalization/term-tagger.js'
import {
  compareToBaseline,
  expectedParagraphSlots,
  formatMetricTable,
  parseRecording,
  renderRecording,
  scoreChapter,
} from './score.js'

const glossary: Glossary = {
  terms: [
    {
      id: 'aelwyn',
      term: 'Aelwyn',
      type: 'character',
      count: 1,
      firstChapter: 1,
      ru: 'Аэлвин',
      aliases: ['Ael'],
    },
  ],
}

const en = '# Chapter 1 — Start\n\nAelwyn walked home.'
const ru = '# Глава 1 — Начало\n\nАэлвин шла домой.'

describe('scoreChapter', () => {
  it('scores a clean hand-built translation', () => {
    const result = scoreChapter(en, ru, glossary)
    expect(result.metrics.parityErrors).toBe(0)
    expect(result.metrics.termConsistencyIssues).toBe(0)
    expect(result.metrics.termConsistency).toBe(1)
    expect(result.metrics.untranslatedShare).toBe(0)
    expect(result.metrics.lengthRatioChars).toBeGreaterThan(0)
    expect(result.findings).toEqual([])
  })

  it('flags an untranslated source term', () => {
    const result = scoreChapter(en, '# Глава 1 — Начало\n\nAelwyn шла домой.', glossary)
    expect(result.metrics.termConsistencyIssues).toBe(1)
    expect(result.metrics.termConsistency).toBe(0)
    expect(result.metrics.untranslatedShare).toBeGreaterThan(0)
    expect(result.findings.some((finding) => finding.code === 'term-consistency')).toBe(true)
  })

  it('flags line-count drift as a parity error', () => {
    const result = scoreChapter(en, '# Глава 1 — Начало\n\nАэлвин шла домой.\n\nЛишняя строка.')
    expect(result.metrics.parityErrors).toBeGreaterThan(0)
    expect(result.findings.some((finding) => finding.code === 'line-count')).toBe(true)
  })
})

describe('recordings', () => {
  it('parses and renders the title plus paragraph slots', () => {
    const reply = parseRecording('{"title":"Глава","paragraphs":["Один.","Два."]}')
    expect(reply.paragraphs).toHaveLength(2)
    expect(renderRecording(reply)).toBe('# Глава\n\nОдин.\n\nДва.')
    expect(expectedParagraphSlots('# Глава\n\nОдин.\n\nДва.')).toBe(2)
  })

  it('rejects malformed JSON with a named parse error', () => {
    expect(() => parseRecording('not json')).toThrow(/not valid JSON/)
  })
})

describe('baseline comparison', () => {
  it('names every metric outside its tolerance', () => {
    const violations = compareToBaseline(
      { parityErrors: 2, cyrillicRatio: 0.5 },
      { parityErrors: { max: 0 }, cyrillicRatio: { min: 0.9 } },
    )
    expect(violations.map((violation) => violation.metric)).toEqual([
      'parityErrors',
      'cyrillicRatio',
    ])
    expect(violations.map((violation) => violation.message)).toEqual([
      'parityErrors 2 above baseline max 0',
      'cyrillicRatio 0.5 below baseline min 0.9',
    ])
  })

  it('treats a missing tolerance as a violation', () => {
    const violations = compareToBaseline({ newMetric: 1 }, {})
    expect(violations[0]?.message).toBe('newMetric has no baseline tolerance')
  })

  it('accepts target ± tolerance ranges', () => {
    const violations = compareToBaseline(
      { termConsistency: 0.94 },
      { termConsistency: { target: 0.95, tolerance: 0.02 } },
    )
    expect(violations).toEqual([])
  })
})

describe('formatMetricTable', () => {
  it('renders one row per metric and one column per chapter', () => {
    const table = formatMetricTable([
      { label: 'chapter1', metrics: { parityErrors: 0, untranslatedShare: 0.0123 } },
      { label: 'chapter2', metrics: { parityErrors: 1, untranslatedShare: 0 } },
    ])
    expect(table).toContain('metric')
    expect(table).toContain('chapter1')
    expect(table).toContain('parityErrors')
    expect(table).toContain('0.0123')
  })
})
