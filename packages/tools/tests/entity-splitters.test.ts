import { createExchange, registry } from '@mt/core'
import type { Chunk, Line, Paragraph, SplitterContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  chunkSplitter,
  lineSplitter,
  paragraphSplitter,
  wordSplitter,
} from '../src/normalization/entity-splitters.js'
import { splitLineUnits, splitParagraphUnits } from '../src/normalization/token-splitter.js'

/** Minimal splitter context: the tunable resolver only reads `run.global`. */
function splitterCtx(env: Record<string, string>): SplitterContext {
  return { run: { global: { env, settings: {} } } } as unknown as SplitterContext
}

describe('splitParagraphUnits / splitLineUnits', () => {
  it('trims units and drops blanks', () => {
    expect(splitParagraphUnits('  one  \n\n \n\n two \n')).toEqual(['one', 'two'])
    expect(splitLineUnits(' one \r\n\r\n two \n  \n three ')).toEqual(['one', 'two', 'three'])
  })
})

describe('splitter registry', () => {
  it('registers chunk, paragraph, line and word splitters by buffer scheme', () => {
    expect(registry.hasSplitter('chunks')).toBe(true)
    expect(registry.hasSplitter('paragraphs')).toBe(true)
    expect(registry.hasSplitter('lines')).toBe(true)
    expect(registry.hasSplitter('words')).toBe(true)
    expect(registry.resolveSplitter('chunks://')).toBe(chunkSplitter)
    expect(registry.resolveSplitter('chunks://ladder')).toBe(chunkSplitter)
    expect(registry.resolveSplitter('#chunks')).toBe(chunkSplitter)
    expect(registry.resolveSplitter('paragraphs://')).toBe(paragraphSplitter)
    expect(registry.resolveSplitter('paragraphs://ladder')).toBe(paragraphSplitter)
    expect(registry.resolveSplitter('#paragraphs')).toBe(paragraphSplitter)
    expect(registry.resolveSplitter('lines://')).toBe(lineSplitter)
    expect(registry.resolveSplitter('lines://ladder')).toBe(lineSplitter)
    expect(registry.resolveSplitter('#lines')).toBe(lineSplitter)
    expect(registry.resolveSplitter('words://')).toBe(wordSplitter)
    expect(registry.resolveSplitter('#words')).toBe(wordSplitter)
  })
})

describe('chunkSplitter', () => {
  const CHAPTER = [
    '---',
    'number: 7',
    '---',
    '',
    '# Chapter Seven',
    '',
    'First paragraph.',
    '',
    'Second paragraph.',
  ].join('\n')

  it('parses chapter markdown into Chunk entities with ids and token counts', () => {
    const chunks = chunkSplitter.split(
      createExchange(CHAPTER, { meta: { chapterId: 'chapter-42' } }),
      splitterCtx({ MT_CHUNK_SIZE: '1000' }),
    )

    expect(chunks).toHaveLength(1)
    const chunk = chunks[0]
    expect(chunk).toMatchObject({
      id: 'chapter-42/chunk-1',
      chapterId: 'chapter-42',
      index: 0,
    })
    expect(chunk?.body).toContain('First paragraph.')
    expect(chunk?.body).toContain('Second paragraph.')
    expect(chunk?.tokens).toBe(Math.ceil((chunk?.body.length ?? 0) / 4))
  })

  it('falls back to the chapter number for the id when meta.chapterId is absent', () => {
    const chunks = chunkSplitter.split(
      createExchange(CHAPTER),
      splitterCtx({ MT_CHUNK_SIZE: '1000' }),
    )

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.chapterId).toBe('chapter-7')
    expect(chunks[0]?.id).toBe('chapter-7/chunk-1')
  })

  it('honors the MT_CHUNK_SIZE budget from the splitter ctx env', () => {
    const markdown = [
      '# Budget',
      '',
      'alpha beta gamma delta epsilon zeta eta theta',
      '',
      'iota kappa lambda mu nu xi omicron pi',
      '',
      'rho sigma tau upsilon phi chi psi omega',
      '',
      'one two three four five six seven eight',
      '',
      'nine ten eleven twelve thirteen fourteen',
    ].join('\n')
    const chunks = chunkSplitter.split(
      createExchange(markdown, { meta: { chapterId: 'chapter-budget' } }),
      splitterCtx({ MT_CHUNK_SIZE: '10' }),
    )

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index))
    for (const chunk of chunks) {
      expect(chunk.tokens).toBeLessThanOrEqual(10)
    }
  })

  it('rejects non-markdown items with a clear error', () => {
    expect(() => chunkSplitter.split(createExchange({ body: 'nope' }))).toThrow(
      'chunkSplitter: item must be a chapter markdown string',
    )
  })
})

describe('paragraphSplitter', () => {
  it('splits a string item and derives ids from meta', () => {
    const env = createExchange(' First paragraph. \n\n\n Second paragraph. \n\n   \n', {
      id: 'exchange-1',
      meta: { chapterId: 'chapter-7', chunkId: 'chunk-3' },
    })

    expect(paragraphSplitter.split(env)).toEqual([
      {
        id: 'chunk-3/paragraph-1',
        chapterId: 'chapter-7',
        chunkId: 'chunk-3',
        index: 0,
        body: 'First paragraph.',
      },
      {
        id: 'chunk-3/paragraph-2',
        chapterId: 'chapter-7',
        chunkId: 'chunk-3',
        index: 1,
        body: 'Second paragraph.',
      },
    ])
  })

  it('accepts a Chunk-like entity and uses its ids', () => {
    const chunk: Chunk = {
      id: 'chunk-9',
      chapterId: 'chapter-2',
      body: 'Alpha\n\nBeta\n\n',
    }

    expect(paragraphSplitter.split(createExchange(chunk, { id: 'envelope' }))).toEqual([
      {
        id: 'chunk-9/paragraph-1',
        chapterId: 'chapter-2',
        chunkId: 'chunk-9',
        index: 0,
        body: 'Alpha',
      },
      {
        id: 'chunk-9/paragraph-2',
        chapterId: 'chapter-2',
        chunkId: 'chunk-9',
        index: 1,
        body: 'Beta',
      },
    ])
  })

  it('falls back to the exchange id when meta ids are absent', () => {
    const env = createExchange('Only paragraph', { id: 'fallback-chunk' })
    expect(paragraphSplitter.split(env)).toEqual([
      {
        id: 'fallback-chunk/paragraph-1',
        chapterId: 'fallback-chunk',
        chunkId: 'fallback-chunk',
        index: 0,
        body: 'Only paragraph',
      },
    ])
  })

  it('matches the old paragraph flatMap behavior', () => {
    const chunk: Chunk = {
      id: 'chunk-old',
      chapterId: 'chapter-old',
      body: 'First\n\nSecond\n\nThird',
    }
    const old = chunk.body
      .split(/\n\n+/)
      .filter((part) => part.trim().length > 0)
      .map((part, index) => ({
        id: `${chunk.id}/paragraph-${index + 1}`,
        chapterId: chunk.chapterId,
        chunkId: chunk.id,
        index,
        body: part,
      }))

    expect(paragraphSplitter.split(createExchange(chunk))).toEqual(old)
  })
})

describe('lineSplitter', () => {
  it('splits a string item and derives the paragraph id from meta', () => {
    const env = createExchange(' first line \r\n\r\n second line \n  \n', {
      id: 'exchange-2',
      meta: { paragraphId: 'paragraph-4' },
    })

    expect(lineSplitter.split(env)).toEqual([
      {
        id: 'paragraph-4/line-1',
        paragraphId: 'paragraph-4',
        index: 0,
        text: 'first line',
      },
      {
        id: 'paragraph-4/line-2',
        paragraphId: 'paragraph-4',
        index: 1,
        text: 'second line',
      },
    ])
  })

  it('accepts a Paragraph-like entity and uses its id', () => {
    const paragraph: Paragraph = {
      id: 'paragraph-9',
      chapterId: 'chapter-3',
      body: 'alpha\nbeta\n',
    }

    expect(lineSplitter.split(createExchange(paragraph, { id: 'envelope' }))).toEqual([
      {
        id: 'paragraph-9/line-1',
        paragraphId: 'paragraph-9',
        index: 0,
        text: 'alpha',
      },
      {
        id: 'paragraph-9/line-2',
        paragraphId: 'paragraph-9',
        index: 1,
        text: 'beta',
      },
    ])
  })

  it('falls back to the exchange id when meta.paragraphId is absent', () => {
    const env = createExchange('only line', { id: 'fallback-paragraph' })
    expect(lineSplitter.split(env)).toEqual([
      {
        id: 'fallback-paragraph/line-1',
        paragraphId: 'fallback-paragraph',
        index: 0,
        text: 'only line',
      },
    ])
  })

  it('matches the old line flatMap behavior for non-blank lines', () => {
    const paragraph: Paragraph = {
      id: 'paragraph-old',
      chapterId: 'chapter-old',
      body: 'First line\nSecond line\nThird line',
    }
    const old = paragraph.body
      .split('\n')
      .map((text, index) => ({
        id: `${paragraph.id}/line-${index + 1}`,
        paragraphId: paragraph.id,
        index,
        text,
      }))
      .filter((line) => line.text.trim().length > 0)

    expect(lineSplitter.split(createExchange(paragraph))).toEqual(old)
  })
})

describe('wordSplitter', () => {
  it('splits a string item and derives ids from meta', () => {
    const env = createExchange('  alpha, beta  gamma. ', {
      id: 'exchange-word',
      meta: { paragraphId: 'paragraph-2', lineId: 'line-5' },
    })

    expect(wordSplitter.split(env)).toEqual([
      {
        id: 'line-5/word-1',
        paragraphId: 'paragraph-2',
        lineId: 'line-5',
        word: 'alpha',
        index: 0,
      },
      {
        id: 'line-5/word-2',
        paragraphId: 'paragraph-2',
        lineId: 'line-5',
        word: 'beta',
        index: 1,
      },
      {
        id: 'line-5/word-3',
        paragraphId: 'paragraph-2',
        lineId: 'line-5',
        word: 'gamma',
        index: 2,
      },
    ])
  })

  it('accepts a Line-like entity and uses its ids', () => {
    const line: Line = {
      id: 'line-9',
      paragraphId: 'paragraph-3',
      text: 'one two',
    }

    expect(wordSplitter.split(createExchange(line))).toEqual([
      {
        id: 'line-9/word-1',
        paragraphId: 'paragraph-3',
        lineId: 'line-9',
        word: 'one',
        index: 0,
      },
      {
        id: 'line-9/word-2',
        paragraphId: 'paragraph-3',
        lineId: 'line-9',
        word: 'two',
        index: 1,
      },
    ])
  })
})
