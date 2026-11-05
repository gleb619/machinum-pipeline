import { createExchange, getVariable, registry } from '@mt/core'
import type { SplitterContext, ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  createSeriesSplitTool,
  createSeriesSplitter,
  readChapterDoc,
  seriesSplitter,
} from '../src/index.js'
import type { ChapterDocNode } from '../src/modification/chapter-doc.js'
import {
  balanceText,
  balancedLineStrategy,
  balancedStrategy,
  countTokens,
  createTokenSplitter,
  heuristicTokenCount,
  lineStrategy,
  overlap,
  paragraphStrategy,
  rebalance,
  rebalanceLines,
  sentenceStrategy,
  singleStrategy,
  tokenSplitter,
  whitespaceStrategy,
  withStrategy,
} from '../src/normalization/token-splitter.js'

const ctx = { run: { global: {} } } as unknown as ToolContext

function paragraph(wordCount: number): string {
  return `${Array.from({ length: wordCount }, (_, i) => `w${i}`).join(' ')}.\n\n`
}

function longText(wordCount: number): string {
  return Array.from({ length: 20 }, () => paragraph(wordCount)).join('')
}

describe('tokenSplitter', () => {
  it('does not split short chapters', async () => {
    const text = 'Short chapter with a few words.'
    const result = await tokenSplitter.invoke(
      { id: 'ex-test', variables: [], item: text, meta: {} },
      ctx,
    )
    expect(result.item).toHaveLength(1)
    expect(result.item[0]).toBe(text)
    expect(getVariable(result, 'strategy')).toBe('paragraph')
  })

  it('splits very long chapters', async () => {
    const text = longText(500)
    const result = await tokenSplitter.invoke(
      { id: 'ex-test', variables: [], item: text, meta: {} },
      ctx,
    )
    expect(result.item.length).toBeGreaterThan(1)
    expect(getVariable(result, 'split')).toBe(true)
    expect(getVariable(result, 'chunkCount')).toBe(result.item.length)
  })

  it('uses .with() to swap strategy', async () => {
    const text = longText(300)
    const sentenceSplitter = tokenSplitter.with({ strategy: sentenceStrategy({ maxChars: 600 }) })
    expect(sentenceSplitter).not.toBe(tokenSplitter)

    const result = await sentenceSplitter.invoke(
      { id: 'ex-test', variables: [], item: text, meta: {} },
      ctx,
    )
    expect(getVariable(result, 'strategy')).toBe('sentence')
    expect(result.item.length).toBeGreaterThan(1)

    const original = await tokenSplitter.invoke(
      { id: 'ex-test', variables: [], item: text, meta: {} },
      ctx,
    )
    expect(getVariable(original, 'strategy')).toBe('paragraph')
  })

  it('supports withStrategy decorator', async () => {
    const text = longText(1000)
    const lineSplitter = withStrategy(tokenSplitter, lineStrategy({ maxTokens: 100 }))
    const result = await lineSplitter.invoke(
      { id: 'ex-test', variables: [], item: text, meta: {} },
      ctx,
    )
    expect(getVariable(result, 'strategy')).toBe('line')
    expect(result.item.length).toBeGreaterThan(1)
  })
})

describe('strategies', () => {
  it('singleStrategy returns one chunk', async () => {
    const text = 'anything'
    expect(await singleStrategy().split(text)).toEqual([text])
  })

  it('paragraphStrategy splits at paragraph boundaries', async () => {
    const text = longText(400)
    const chunks = await paragraphStrategy({ targetTokens: 500 }).split(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(heuristicTokenCount(chunk)).toBeLessThanOrEqual(500 + 100)
    }
  })

  it('lineStrategy splits at line boundaries', async () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n')
    const chunks = await lineStrategy({ maxTokens: 100 }).split(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.split('\n').length).toBeGreaterThanOrEqual(1)
    }
  })

  it('whitespaceStrategy splits at word boundaries', async () => {
    const text = 'word '.repeat(400).trim()
    const chunks = await whitespaceStrategy({ maxTokens: 50 }).split(text)
    expect(chunks.length).toBeGreaterThan(1)
    const first = chunks[0]
    expect(first).toBeDefined()
    expect(first?.includes(' ')).toBe(true)
  })

  it('sentenceStrategy preserves sentence boundaries', async () => {
    const sentences = Array.from(
      { length: 10 },
      (_, i) => `Sentence ${i} has many words and ends here.`,
    )
    const text = sentences.join(' ')
    const chunks = await sentenceStrategy({ maxChars: 120 }).split(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.endsWith('.') || chunk.endsWith('!') || chunk.endsWith('?')).toBe(true)
    }
  })

  it('balancedStrategy creates evenly sized chunks', async () => {
    const text = longText(200)
    const chunks = await balancedStrategy({ targetTokens: 400 }).split(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length > 0)).toBe(true)
  })

  it('balancedLineStrategy preserves line order and boundaries', async () => {
    const lines = [
      'alpha line one',
      'beta line two is somewhat longer',
      'gamma',
      'delta delta delta',
      'epsilon here',
      'zeta zeta zeta zeta',
      'eta',
      'theta theta theta',
      'iota iota',
      'kappa',
    ]
    const text = lines.join('\n')
    const chunks = await balancedLineStrategy({ maxTokens: 8 }).split(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('\n')).toBe(lines.join('\n'))
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        expect(lines).toContain(line)
      }
    }
  })

  it('balancedLineStrategy applies overlap', async () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i} ${'a'.repeat(40)}`).join('\n')
    const chunks = await balancedLineStrategy({ maxTokens: 100, overlapChars: 20 }).split(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (let i = 0; i < chunks.length - 1; i++) {
      const current = chunks[i]
      const next = chunks[i + 1]
      if (current === undefined || next === undefined) continue
      expect(current.endsWith(next.slice(0, 20))).toBe(true)
    }
  })
})

describe('helpers', () => {
  it('heuristicTokenCount approximates 4 chars per token', () => {
    expect(heuristicTokenCount('abcd')).toBe(1)
    expect(heuristicTokenCount('abcdefgh')).toBe(2)
  })

  it('countTokens returns a positive number', async () => {
    const count = await countTokens('hello world')
    expect(count).toBeGreaterThan(0)
  })

  it('balanceText distributes lines into chunks', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const chunks = balanceText(text, 4)
    expect(chunks).toHaveLength(4)
    expect(chunks.join('\n')).toBe(text)
  })

  it('overlap appends the start of the next chunk', () => {
    const input = ['aaa', 'bbb', 'ccc']
    expect(overlap(input, 2)).toEqual(['aaabb', 'bbbcc', 'ccc'])
  })

  it('rebalance moves characters between chunks preserving order', () => {
    const input = ['aaaa', 'b']
    expect(rebalance(input)).toEqual(['aaa', 'ab'])
  })

  it('rebalance preserves the overall character order', () => {
    const input = ['abcdefgh', '12']
    const result = rebalance(input)
    expect(result.join('')).toBe('abcdefgh12')
    expect(result).toEqual(['abcde', 'fgh12'])
  })

  it('rebalanceLines shifts whole lines and preserves order', () => {
    const chunks = ['l1\nl2\nl3\nl4\nl5', 'l6', 'l7']
    const result = rebalanceLines(chunks)
    expect(result.join('\n')).toBe(chunks.join('\n'))
    for (const chunk of result) {
      for (const line of chunk.split('\n')) {
        expect(['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7']).toContain(line)
      }
    }
  })
})

describe('createTokenSplitter', () => {
  it('respects custom maxTokens', async () => {
    const splitter = createTokenSplitter({
      strategy: singleStrategy(),
      maxTokens: 10,
    })
    const text = 'hello world this is longer than ten tokens maybe'
    const result = await splitter.invoke(
      { id: 'ex-test', variables: [], item: text, meta: {} },
      ctx,
    )
    expect(getVariable(result, 'strategy')).toBe('single')
    expect(result.item).toEqual([text])
  })
})

// ---------------------------------------------------------------------------
// Series split
// ---------------------------------------------------------------------------

/** Paragraph lines of a parsed part, in document order. */
function paragraphLines(doc: ChapterDocNode): string[][] {
  return doc
    .chapterTree()
    .paragraphs()
    .map((paragraph) => paragraph.lines.map((line) => line.text))
}

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

/** Minimal splitter context: the tunable resolver only reads `run.global`. */
function splitterCtx(env: Record<string, string>): SplitterContext {
  return { run: { global: { env, settings: {} } } } as unknown as SplitterContext
}

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
    expect(docs.map((doc) => paragraphLines(doc).length)).toEqual([2, 2, 2, 2])
    expect(docs.map((doc) => doc.chapter.title)).toEqual([
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

    const sourceLines = paragraphLines(readChapterDoc(LARGE)).flat()
    expect(docs.flatMap((doc) => paragraphLines(doc).flat())).toEqual(sourceLines)
  })

  it('preserves an existing series name, chapter number and warnings', async () => {
    const splitter = createSeriesSplitter({ parts: 2 })
    const parts = await splitter.split(createExchange(LARGE_WITH_METADATA))
    const docs = parts.map((part) => readChapterDoc(part))

    expect(parts).toHaveLength(2)
    for (const doc of docs) {
      expect(doc.chapter.title).toMatch(/^Chapter One [12]$/)
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
    expect(parts.map((part) => readChapterDoc(part).chapter.title)).toEqual([
      'Tiny Chapter 1',
      'Tiny Chapter 2',
      'Tiny Chapter 3',
      'Tiny Chapter 4',
    ])
    expect(parts.map((part) => paragraphLines(readChapterDoc(part))[0]?.join(' '))).toEqual([
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
    const bodies = parts.map((part) => paragraphLines(readChapterDoc(part)).flat().join(' ').trim())

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
    const bodies = parts.map((part) => paragraphLines(readChapterDoc(part)).flat().join(' ').trim())

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

    it('default 10k target leaves a short chapter whole when resolved through ctx', async () => {
      // Meaningful body is far below SERIES_SPLIT_TARGET_CHARS (10_000).
      expect(await seriesSplitter.split(createExchange(LARGE), splitterCtx({}))).toEqual([LARGE])
    })

    it('resolves MT_CONST_SERIES_SPLIT_TARGET_CHARS through ctx', async () => {
      const parts = await seriesSplitter.split(
        createExchange(BALANCED_BIG),
        splitterCtx({ MT_CONST_SERIES_SPLIT_TARGET_CHARS: '100' }),
      )
      expect(parts.length).toBeGreaterThan(1)
    })

    it('splits a chapter above the target into approximately equal shares', async () => {
      const parts = await createSeriesSplitter({ targetChars: 100 }).split(
        createExchange(BALANCED_BIG),
      )
      const docs = parts.map((part) => readChapterDoc(part))
      const sizes = docs.map((doc) => paragraphLines(doc).flat().join('\n').length)

      expect(parts.length).toBeGreaterThan(1)
      // 8 paragraphs of ~150 chars each: with a 100-char target every part holds exactly
      // one paragraph, and none is wildly bigger than the target.
      expect(parts).toHaveLength(8)
      for (const size of sizes) {
        expect(size).toBeLessThan(200)
      }
      // Round-trip: no line lost or duplicated.
      const sourceLines = paragraphLines(readChapterDoc(BALANCED_BIG)).flat()
      expect(docs.flatMap((doc) => paragraphLines(doc).flat())).toEqual(sourceLines)
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
