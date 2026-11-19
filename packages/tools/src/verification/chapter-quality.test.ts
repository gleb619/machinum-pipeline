import { describe, expect, it } from 'vitest'
import {
  type ChapterQuality,
  THRESHOLDS,
  buildQuality,
  flawedQuoteParagraph,
  foreignScriptPct,
  isProperNoun,
  leakLines,
  quotePct,
  serializeQuality,
} from './chapter-quality.js'

function chapter(n: number, overrides: Partial<ChapterQuality> = {}): ChapterQuality {
  return {
    n,
    per1kTypos: 0,
    forbidden: 0,
    structure: 0,
    leaks: 0,
    foreignPct: 0,
    quotePct: 0,
    tokPerWord: 1.5,
    pass: true,
    reasons: [],
    ...overrides,
  }
}

describe('pure quality signals', () => {
  it('counts only non-Latin letters as foreign script', () => {
    expect(foreignScriptPct('hello world')).toBe(0)
    expect(foreignScriptPct('')).toBe(0)
    expect(foreignScriptPct('hello мир')).toBeCloseTo((3 / 8) * 100, 6)
    expect(foreignScriptPct('Привет')).toBeCloseTo(100, 6)
  })

  it('flags metadata, translator notes, URLs, markup and citations as leaks', () => {
    const text = [
      'Plain prose.',
      'TL;DR: summary',
      "Translator's note: keep this",
      'Source: archive',
      'https://example.com/x',
      '<b>bold</b>',
      'A citation [12].',
    ].join('\n')
    expect(leakLines(text)).toBe(6)
    expect(leakLines('Plain prose.\n\nMore prose.')).toBe(0)
  })

  it('detects unpaired curly quotes, odd straight quotes and broken dialogue', () => {
    expect(flawedQuoteParagraph('“A balanced sentence.”')).toBe(false)
    expect(flawedQuoteParagraph('“An unbalanced sentence.')).toBe(true)
    expect(flawedQuoteParagraph('He said "hello.')).toBe(true)
    expect(flawedQuoteParagraph('”A broken continuation.')).toBe(true)
    expect(flawedQuoteParagraph('"A one-line quote."')).toBe(false)
  })

  it('reports the share of flawed paragraphs', () => {
    expect(quotePct('“Good.”\n\n“Bad.')).toBe(50)
    expect(quotePct('')).toBe(0)
    expect(quotePct('“Good.”\n\n“Also good.”')).toBe(0)
  })
})

describe('proper nouns', () => {
  it('matches names case-insensitively and ignores punctuation and possessives', () => {
    const names = new Set(['kestrel point', 'kestrel'])

    expect(isProperNoun('Kestrel', names)).toBe(true)
    expect(isProperNoun("Kestrel's", names)).toBe(true)
    expect(isProperNoun('kestrel,', names)).toBe(true)
    expect(isProperNoun('harbour', names)).toBe(false)
    expect(isProperNoun('', names)).toBe(false)
  })
})

describe('buildQuality', () => {
  it('passes a clean book and sorts chapters by n', () => {
    const artifact = buildQuality({
      chapters: [chapter(2), chapter(1)],
      source: 'md://book',
      ratioToMean: new Map([
        [1, 1],
        [2, 1],
      ]),
    })

    expect(artifact.verdict).toBe('translate')
    expect(artifact.summary).toEqual({ passRate: 1, hard: [] })
    expect(artifact.chapters.map((row) => row.n)).toEqual([1, 2])
    expect(artifact.thresholds).toEqual(THRESHOLDS)
  })

  it('sends the book to preprocess when a hard reason tripped', () => {
    const artifact = buildQuality({
      chapters: [chapter(1), chapter(2, { pass: false, reasons: ['leaks'], leaks: 1 })],
      source: 'md://book',
    })

    expect(artifact.verdict).toBe('preprocess')
    expect(artifact.summary.hard).toEqual([2])
    expect(artifact.summary.passRate).toBe(0.5)
  })

  it('fails the pass-rate gate on soft reasons', () => {
    const chapters = Array.from({ length: 10 }, (_, index) =>
      index < 8
        ? chapter(index + 1)
        : chapter(index + 1, { pass: false, reasons: ['typos'], per1kTypos: 10 }),
    )
    const artifact = buildQuality({ chapters, source: 'md://book' })

    expect(artifact.summary.hard).toEqual([])
    expect(artifact.summary.passRate).toBe(0.8)
    expect(artifact.verdict).toBe('preprocess')
  })

  it('applies threshold overrides and recomputes reasons from the signals', () => {
    const artifact = buildQuality({
      chapters: [chapter(1, { per1kTypos: 6, pass: false, reasons: ['typos'] })],
      source: 'md://book',
      thresholds: { typosPer1k: 10 },
    })

    expect(artifact.thresholds.typosPer1k).toBe(10)
    expect(artifact.chapters[0]?.pass).toBe(true)
    expect(artifact.chapters[0]?.reasons).toEqual([])
    expect(artifact.verdict).toBe('translate')
  })
})

describe('serialization', () => {
  it('serializes a byte-stable artifact with a trailing newline', () => {
    const artifact = buildQuality({
      chapters: [chapter(1, { reasons: [] })],
      source: 'md://book',
    })
    const text = serializeQuality(artifact)

    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual(artifact)
    expect(serializeQuality(artifact)).toBe(text)
  })

  it('keeps short chapter arrays inline', () => {
    const artifact = buildQuality({
      chapters: [chapter(1), chapter(2)],
      source: 'md://book',
    })
    expect(serializeQuality(artifact)).toContain('[\n')
    expect(serializeQuality({ ...artifact, chapters: [] })).not.toContain('"chapters": [\n')
  })
})
