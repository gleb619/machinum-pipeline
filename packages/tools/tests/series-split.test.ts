import { createExchange, getVariable, registry } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  createSeriesSplitTool,
  createSeriesSplitter,
  readChapterDoc,
  seriesSplitter,
} from '../src/index.js'

const LARGE = [
  '# Chapter One',
  '',
  ...Array.from({ length: 8 }, (_, index) => [
    `Paragraph ${index + 1} line one.`,
    `Paragraph ${index + 1} line two.`,
  ]).flatMap((lines) => [...lines, '']),
].join('\n')

const LARGE_WITH_METADATA = [
  '---',
  'number: 7',
  'series: Existing Saga',
  'warnings:',
  '  - id: 3',
  '    text: Fix this warning',
  '---',
  '',
  LARGE,
].join('\n')

const SMALL = '# Tiny Chapter\n\nOnly one line.\n'
const FORCEABLE = '# Tiny Chapter\n\nOne. Two. Three. Four.\n'

/** Body bigger than the small test target: ~380 meaningful characters. */
const BALANCED_BIG = [
  '# Saga Chapter',
  '',
  ...Array.from({ length: 8 }, (_, index) => [
    `Paragraph ${index + 1} opens with a long descriptive line that carries real weight.`,
    `Paragraph ${index + 1} closes with another long reflective line to add more bulk.`,
  ]).flatMap((lines) => [...lines, '']),
].join('\n')

describe('seriesSplitter', () => {
  it('is registered under the series scheme and its URI/shortcut forms', () => {
    expect(registry.hasSplitter('series')).toBe(true)
    expect(registry.resolveSplitter('series://')).toBe(seriesSplitter)
    expect(registry.resolveSplitter('series://ladder')).toBe(seriesSplitter)
    expect(registry.resolveSplitter('#series')).toBe(seriesSplitter)
    expect(() => registry.resolveSplitter('series')).toThrow(/must be a buffer URI/)
  })

  it('registers every tools splitter after importing @mt/tools', () => {
    expect(registry.resolveSplitter('paragraphs://').name).toBe('paragraph-splitter')
    expect(registry.resolveSplitter('lines://').name).toBe('line-splitter')
    expect(registry.resolveSplitter('words://').name).toBe('word-splitter')
    expect(registry.resolveSplitter('series://').name).toBe('series-splitter')
  })

  it('splits a large chapter document into N numbered parts at paragraph boundaries', async () => {
    const splitter = createSeriesSplitter({ parts: 4 })
    const parts = await splitter.split(createExchange(LARGE))
    const docs = parts.map((part) => readChapterDoc(part))

    expect(parts).toHaveLength(4)
    expect(docs.map((doc) => doc.body.length)).toEqual([2, 2, 2, 2])
    expect(docs.map((doc) => doc.title)).toEqual([
      'Chapter One 1',
      'Chapter One 2',
      'Chapter One 3',
      'Chapter One 4',
    ])
    expect(docs.map((doc) => doc.series)).toEqual([
      'Chapter One',
      'Chapter One',
      'Chapter One',
      'Chapter One',
    ])

    const sourceLines = readChapterDoc(LARGE).body.flatMap((paragraph) => paragraph.lines)
    expect(docs.flatMap((doc) => doc.body.flatMap((paragraph) => paragraph.lines))).toEqual(
      sourceLines,
    )
  })

  it('preserves an existing series name, chapter number and warnings', async () => {
    const splitter = createSeriesSplitter({ parts: 2 })
    const parts = await splitter.split(createExchange(LARGE_WITH_METADATA))
    const docs = parts.map((part) => readChapterDoc(part))

    expect(parts).toHaveLength(2)
    for (const doc of docs) {
      expect(doc.title).toMatch(/^Chapter One [12]$/)
      expect(doc.series).toBe('Existing Saga')
      expect(doc.number).toBe(7)
      expect(doc.warnings).toEqual([{ id: 3, text: 'Fix this warning' }])
    }
  })

  it('returns a small chapter unchanged as one item without series frontmatter', async () => {
    const parts = await seriesSplitter.split(createExchange(SMALL))

    expect(parts).toEqual([SMALL])
    expect(parts[0]).not.toContain('series:')
  })

  it('createSeriesSplitter honors the parts option', async () => {
    const splitter = createSeriesSplitter({ parts: 2 })
    expect(await splitter.split(createExchange(LARGE))).toHaveLength(2)
  })

  it('custom shouldSplit can force a split below the default threshold', async () => {
    const splitter = createSeriesSplitter({ parts: 4, shouldSplit: () => true })
    const parts = await splitter.split(createExchange(FORCEABLE))

    expect(parts).toHaveLength(4)
    expect(parts.map((part) => readChapterDoc(part).title)).toEqual([
      'Tiny Chapter 1',
      'Tiny Chapter 2',
      'Tiny Chapter 3',
      'Tiny Chapter 4',
    ])
    expect(parts.map((part) => readChapterDoc(part).body[0]?.lines.join(' '))).toEqual([
      'One.',
      'Two.',
      'Three.',
      'Four.',
    ])
  })

  it('never cuts a sentence in half', async () => {
    const text = '# Readable\n\nFirst sentence. Second sentence! Third sentence? Fourth sentence.\n'
    const splitter = createSeriesSplitter({ parts: 3 })
    const parts = await splitter.split(createExchange(text))
    const bodies = parts.map((part) =>
      readChapterDoc(part)
        .body.flatMap((paragraph) => paragraph.lines)
        .join(' ')
        .trim(),
    )

    expect(bodies.join(' ')).toContain('First sentence. Second sentence!')
    expect(bodies.join(' ')).toContain('Third sentence?')
    expect(bodies.join(' ')).toContain('Fourth sentence.')
    for (const body of bodies) {
      expect(body).toMatch(/[.!?]$/)
    }
  })

  it('custom shouldSplit can deny a split of a large chapter', async () => {
    const splitter = createSeriesSplitter({ parts: 2, shouldSplit: () => false })
    expect(await splitter.split(createExchange(LARGE))).toEqual([LARGE])
  })

  it('drops decorative-only paragraphs and never emits a decorative-only part', async () => {
    const text = [
      '# Decorated',
      '',
      '---',
      '',
      'First paragraph.',
      '',
      '***',
      '',
      'Second paragraph.',
      '',
      '___',
      '',
      'Third paragraph.',
    ].join('\n')
    const parts = await createSeriesSplitter({ parts: 3 }).split(createExchange(text))
    const bodies = parts.map((part) =>
      readChapterDoc(part)
        .body.flatMap((paragraph) => paragraph.lines)
        .join(' ')
        .trim(),
    )

    expect(bodies).toEqual(['First paragraph.', 'Second paragraph.', 'Third paragraph.'])
    expect(bodies.every((body) => /[\p{L}\p{N}]/u.test(body))).toBe(true)
  })

  it('rejects non-string items with a clear error', async () => {
    await expect(seriesSplitter.split(createExchange(['not', 'text']))).rejects.toThrow(
      'seriesSplitter: item must be a string',
    )
  })

  describe('balanced strategy (default, no explicit parts)', () => {
    it('leaves a chapter at or below the target size whole', async () => {
      // Meaningful body is ~1200 characters, below the 2000 target.
      const parts = await createSeriesSplitter({ targetChars: 2000 }).split(
        createExchange(BALANCED_BIG),
      )
      expect(parts).toEqual([BALANCED_BIG])
    })

    it('the registered default splitter does not split mid-size chapters', async () => {
      // Meaningful body is far below SERIES_SPLIT_TARGET_CHARS (10_000).
      expect(await seriesSplitter.split(createExchange(LARGE))).toEqual([LARGE])
    })

    it('splits a chapter above the target into approximately equal shares', async () => {
      const parts = await createSeriesSplitter({ targetChars: 100 }).split(
        createExchange(BALANCED_BIG),
      )
      const docs = parts.map((part) => readChapterDoc(part))
      const sizes = docs.map(
        (doc) => doc.body.flatMap((paragraph) => paragraph.lines.join('\n')).join('\n').length,
      )

      expect(parts.length).toBeGreaterThan(1)
      // 8 paragraphs of ~150 chars each: with a 100-char target every part holds exactly
      // one paragraph, and none is wildly bigger than the target.
      expect(parts).toHaveLength(8)
      for (const size of sizes) {
        expect(size).toBeLessThan(200)
      }
      // Round-trip: no line lost or duplicated.
      const sourceLines = readChapterDoc(BALANCED_BIG).body.flatMap((paragraph) => paragraph.lines)
      expect(docs.flatMap((doc) => doc.body.flatMap((paragraph) => paragraph.lines))).toEqual(
        sourceLines,
      )
    })

    it('an explicit parts option overrides the balanced strategy', async () => {
      const parts = await createSeriesSplitter({ targetChars: 100, parts: 2 }).split(
        createExchange(BALANCED_BIG),
      )
      expect(parts).toHaveLength(2)
    })
  })
})

describe('seriesSplitTool (backward compatibility)', () => {
  it('reuses splitter parts and sets series/partCount variables', async () => {
    const tool = createSeriesSplitTool({ parts: 2 })
    const output = await tool.invoke(createExchange(LARGE), {} as ToolContext)

    expect(output.item).toHaveLength(2)
    expect(getVariable(output, 'series')).toBe('Chapter One')
    expect(getVariable(output, 'partCount')).toBe(2)
  })

  it('leaves the chapter unchanged and sets no variables when the split condition fails', async () => {
    const tool = createSeriesSplitTool({ parts: 4 })
    const output = await tool.invoke(createExchange(SMALL), {} as ToolContext)

    expect(output.item).toEqual([SMALL])
    expect(getVariable(output, 'series')).toBeUndefined()
    expect(getVariable(output, 'partCount')).toBeUndefined()
  })
})
