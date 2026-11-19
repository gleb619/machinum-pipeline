import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ChapterQuality,
  THRESHOLDS,
  buildQuality,
  compactArrays,
  flawedQuoteParagraph,
  foreignScriptPct,
  leakLines,
  quotePct,
  readRatioToMean,
  serializeQuality,
} from './quality.js'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mt-bookkit-quality-'))
  roots.push(root)
  return root
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

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
  it('inlines short arrays and keeps long ones multiline', () => {
    const short = compactArrays(JSON.stringify({ a: [1, 2, 3] }, null, 2))
    expect(short).toContain('[1, 2, 3]')

    const long = compactArrays(JSON.stringify({ a: ['x'.repeat(60), 'y'.repeat(60)] }, null, 2))
    expect(long).toContain('[\n')
  })

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
})

describe('readRatioToMean', () => {
  it('reads ratios from <root>/chapters/schema/stats.json', async () => {
    const root = await tempRoot()
    await writeJson(join(root, 'chapters', 'schema', 'stats.json'), {
      chapters: [
        { n: 1, ratioToMean: 0.75 },
        { n: 2, ratioToMean: 1.25 },
      ],
    })

    expect([...readRatioToMean({ root })]).toEqual([
      [1, 0.75],
      [2, 1.25],
    ])
  })

  it('fails loudly when the stats stage has not run', async () => {
    const root = await tempRoot()
    expect(() => readRatioToMean({ root })).toThrow(/stats\.json missing/)
  })
})
