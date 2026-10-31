import { createExchange, getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHUNK_SEPARATOR,
  VAR_CHUNK_COUNT,
  VAR_CHUNK_SEPARATOR,
  chunkClean,
  chunkSplit,
  createChunkSplit,
  joinChunks,
  parseChunks,
  resolveChunkSize,
  splitIntoChunks,
  stripSeparators,
} from './chunk-separator.js'
import { DEFAULT_CHUNK_TARGET, heuristicTokenCount } from './token-splitter.js'

function ctxStub(settings: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  return { run: { global: { settings, env } } } as unknown as ToolContext
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Ten 400-char paragraphs → 100 heuristic tokens each. */
function prose(paragraphs = 10, chars = 400): string {
  return Array.from({ length: paragraphs }, (_, i) => `p${i} `.padEnd(chars, 'x').trim()).join(
    '\n\n',
  )
}

describe('stripSeparators', () => {
  it('removes separator lines and decorative-only lines, collapsing blank runs', () => {
    const input = 'first part\n\n---\n\n\nsecond part\n***\n\nthird part\n'
    expect(stripSeparators(input)).toBe('first part\n\nsecond part\n\nthird part')
  })

  it('removes separator lines with surrounding whitespace', () => {
    expect(stripSeparators('a\n  ---  \nb')).toBe('a\nb')
  })

  it('supports a custom separator', () => {
    expect(stripSeparators('a\n###\nb\n===\nc', '===')).toBe('a\nb\nc')
  })
})

describe('splitIntoChunks', () => {
  it('keeps every chunk at or below the token target', () => {
    const chunks = splitIntoChunks(prose(), { targetTokens: 250 })
    expect(chunks.length).toBe(5)
    for (const chunk of chunks) {
      expect(heuristicTokenCount(chunk)).toBeLessThanOrEqual(250)
    }
  })

  it('never loses or reorders text (whitespace-collapsed join equals input)', () => {
    const input = prose(7, 300)
    const chunks = splitIntoChunks(input, { targetTokens: 200 })
    expect(collapse(chunks.join(' '))).toBe(collapse(input))
  })

  it('strips existing separators before splitting', () => {
    const chunks = splitIntoChunks('one\n\n---\n\ntwo', { targetTokens: 1000 })
    expect(chunks).toEqual(['one\n\ntwo'])
  })

  it('splits an over-long single line at word boundaries, never mid-word', () => {
    const line = Array.from({ length: 150 }, (_, i) => `w${i}abcde`).join(' ')
    const chunks = splitIntoChunks(line, { targetTokens: 50 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(heuristicTokenCount(chunk)).toBeLessThanOrEqual(50)
      expect(chunk).not.toMatch(/^\s|\s$/)
    }
    expect(collapse(chunks.join(' '))).toBe(collapse(line))
  })

  it('splits an over-long paragraph at line boundaries', () => {
    const paragraph = Array.from({ length: 4 }, (_, i) => `line${i} `.padEnd(200, 'y').trim()).join(
      '\n',
    )
    const chunks = splitIntoChunks(paragraph, { targetTokens: 80 })
    expect(chunks.length).toBe(4)
    expect(collapse(chunks.join(' '))).toBe(collapse(paragraph))
  })

  it('returns an empty list for empty input', () => {
    expect(splitIntoChunks('   \n\n', {})).toEqual([])
  })
})

describe('joinChunks / parseChunks', () => {
  it('round-trips chunks through the separator text form', () => {
    const chunks = ['alpha beta', 'gamma\ndelta', 'epsilon']
    const text = joinChunks(chunks)
    expect(text).toBe('alpha beta\n\n---\n\ngamma\ndelta\n\n---\n\nepsilon')
    expect(parseChunks(text)).toEqual(chunks)
  })

  it('supports a custom separator', () => {
    const text = joinChunks(['a', 'b'], '===')
    expect(text).toBe('a\n\n===\n\nb')
    expect(parseChunks(text, '===')).toEqual(['a', 'b'])
  })

  it('parses text without separators as a single chunk', () => {
    expect(parseChunks('no separators\nhere')).toEqual(['no separators\nhere'])
    expect(parseChunks('  \n ')).toEqual([])
  })
})

describe('chunkSplit tool', () => {
  it('splits, fixates with separator lines, and reports chunkCount in variable and meta', async () => {
    const small = await chunkSplit.invoke(
      createExchange(prose(), { meta: { chunkSize: 250 } }),
      ctxStub(),
    )
    expect(small.item.split('\n\n---\n\n').length).toBe(5)
    expect(getVariable(small, VAR_CHUNK_COUNT)).toBe(5)
    expect(small.meta.chunkCount).toBe(5)
    expect(getVariable(small, VAR_CHUNK_SEPARATOR)).toBe(DEFAULT_CHUNK_SEPARATOR)
    for (const chunk of parseChunks(small.item)) {
      expect(heuristicTokenCount(chunk)).toBeLessThanOrEqual(250)
    }
  })

  it('a second run reuses the fixated separators and yields identical chunks', async () => {
    const small = createChunkSplit({ chunkSize: 250 })
    const first = await small.invoke(createExchange(prose()), ctxStub())
    const second = await small.invoke(createExchange(first.item), ctxStub())
    expect(second.item).toBe(first.item)
    expect(getVariable(second, VAR_CHUNK_COUNT)).toBe(getVariable(first, VAR_CHUNK_COUNT))
  })

  it('reuse: false re-splits text that already contains separators', async () => {
    const fixated = 'short block\n---\nanother short block'
    const splitter = createChunkSplit({ chunkSize: 1000 })
    const kept = await splitter.invoke(createExchange(fixated), ctxStub())
    expect(kept.item).toBe(fixated)

    const resplitter = createChunkSplit({ chunkSize: 1000, reuse: false })
    const resplit = await resplitter.invoke(createExchange(fixated), ctxStub())
    expect(resplit.item).toBe('short block\nanother short block')
    expect(getVariable(resplit, VAR_CHUNK_COUNT)).toBe(1)
  })
})

describe('chunkClean tool', () => {
  it('strips separators and reports chunkCount in variable and meta', async () => {
    const out = await chunkClean.invoke(createExchange('a\n\n---\n\nb\n***\n\nc'), ctxStub())
    expect(out.item).toBe('a\n\nb\n\nc')
    expect(getVariable(out, VAR_CHUNK_COUNT)).toBe(1)
    expect(out.meta.chunkCount).toBe(1)
    expect(getVariable(out, VAR_CHUNK_SEPARATOR)).toBe(DEFAULT_CHUNK_SEPARATOR)
  })
})

describe('resolveChunkSize', () => {
  it('meta.chunkSize wins over the tool option', () => {
    expect(
      resolveChunkSize({ meta: { chunkSize: 111 } }, ctxStub({ chunkSize: 300 }), {
        chunkSize: 222,
      }),
    ).toBe(111)
  })

  it('tool option wins over mt.json settings', () => {
    expect(resolveChunkSize({ meta: {} }, ctxStub({ chunkSize: 300 }), { chunkSize: 222 })).toBe(
      222,
    )
  })

  it('mt.json settings win over the MT_CHUNK_SIZE env var', () => {
    process.env.MT_CHUNK_SIZE = '444'
    try {
      expect(resolveChunkSize({ meta: {} }, ctxStub({ chunkSize: 300 }))).toBe(300)
    } finally {
      Reflect.deleteProperty(process.env, 'MT_CHUNK_SIZE')
    }
  })

  it('MT_CHUNK_SIZE env wins over the default target', () => {
    process.env.MT_CHUNK_SIZE = '444'
    try {
      expect(resolveChunkSize({ meta: {} }, ctxStub())).toBe(444)
      expect(resolveChunkSize({ meta: {} })).toBe(444)
    } finally {
      Reflect.deleteProperty(process.env, 'MT_CHUNK_SIZE')
    }
  })

  it('falls back to the default chunk target', () => {
    expect(resolveChunkSize({ meta: {} }, ctxStub())).toBe(DEFAULT_CHUNK_TARGET)
  })
})
