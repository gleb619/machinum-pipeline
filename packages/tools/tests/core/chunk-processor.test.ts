import { defineTool, getVariable, withItem } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  type ChunkBudget,
  VAR_CHUNK_PROCESSOR,
  adaptiveSemanticChunks,
  estimateReasoningReserve,
  groupItemsToBudget,
  processChunks,
  processTextInChunks,
  resolveChunkBudget,
  shouldChunkText,
  withTextChunks,
} from '../../src/core/chunk-processor.js'

const ctx = {} as ToolContext
const countTokens = (text: string) => Math.ceil(text.length / 4)

function budget(limit: number, outputReserve = 0): ChunkBudget {
  return {
    limit,
    outputReserve,
    thinkReserve: 0,
    overhead: 0,
    reserve: 0,
    inputBudget: limit - outputReserve,
    model: 'openai/gpt-4o-mini',
  }
}

describe('resolveChunkBudget', () => {
  it('uses explicit contextLimit when provided', () => {
    const b = resolveChunkBudget({ input: { contextLimit: 1000, outputReserve: 100 } })
    expect(b).toMatchObject({ limit: 1000, inputBudget: 836, model: 'openai/gpt-4o-mini' })
  })

  it('defaults reserve and reasoning reserve', () => {
    const b = resolveChunkBudget({ input: { contextLimit: 2000, outputReserve: 200 } })
    expect(b?.reserve).toBe(64)
    expect(b?.thinkReserve).toBe(0)
    expect(b?.inputBudget).toBe(1736)
  })

  it('adds reasoning reserve for o1/o3/o4 models', () => {
    expect(estimateReasoningReserve('openai/o3-mini')).toBe(8000)
    expect(estimateReasoningReserve('anthropic/claude-4-sonnet')).toBe(4000)
    expect(estimateReasoningReserve('deepseek/deepseek-r1')).toBe(4000)
    expect(estimateReasoningReserve('qwen/qwq-32b')).toBe(4000)
    expect(estimateReasoningReserve('openai/gpt-4o')).toBe(0)
  })
})

describe('shouldChunkText', () => {
  it('returns false when text fits budget', () => {
    expect(shouldChunkText('abcd', budget(2), countTokens)).toBe(false)
  })

  it('returns true when text exceeds budget', () => {
    expect(shouldChunkText('abcdefghi', budget(2), countTokens)).toBe(true)
  })
})

describe('adaptiveSemanticChunks', () => {
  it('returns single chunk when text fits', () => {
    const chunks = adaptiveSemanticChunks('one paragraph', budget(10), { count: countTokens })
    expect(chunks).toEqual(['one paragraph'])
  })

  it('splits by paragraph first', () => {
    const text = 'p1 line one.\n\np2 line two.\n\np3 line three.'
    const chunks = adaptiveSemanticChunks(text, budget(8), { count: countTokens })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0]).toContain('p1')
  })

  it('falls back from paragraphs to sentences to words', () => {
    // single paragraph with many short sentences; budget forces splitting
    const text = 'A. B. C. D. E. F.'
    const chunks = adaptiveSemanticChunks(text, budget(2), { count: countTokens })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const chunk of chunks) {
      expect(countTokens(chunk)).toBeLessThanOrEqual(2)
    }
  })

  it('uses requested unit directly', () => {
    const text = 'one two three four five six seven eight'
    const chunks = adaptiveSemanticChunks(text, budget(2), { unit: 'word', count: countTokens })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0]?.split(' ').length).toBeLessThanOrEqual(2)
  })
})

describe('groupItemsToBudget', () => {
  it('groups items greedily by weight', () => {
    const groups = groupItemsToBudget({
      items: ['a', 'bb', 'ccc', 'dddd'],
      budget: budget(3),
      weigh: (g) => g.length,
      render: (g) => g.join(','),
    })
    expect(groups.length).toBeGreaterThanOrEqual(2)
    expect(groups.join(',').split(',').sort()).toEqual(['a', 'bb', 'ccc', 'dddd'].sort())
  })
})

describe('processChunks', () => {
  it('processes single chunk directly', async () => {
    const result = await processChunks({
      chunks: ['hello'],
      process: async (chunk) => chunk.toUpperCase(),
      merge: (outs) => outs.join(' '),
    })
    expect(result).toBe('HELLO')
  })

  it('processes multiple chunks and merges', async () => {
    const result = await processChunks({
      chunks: ['a', 'b', 'c'],
      process: async (chunk) => chunk.toUpperCase(),
      merge: (outs) => outs.join('-'),
      concurrency: 2,
    })
    expect(result).toBe('A-B-C')
  })
})

describe('processTextInChunks', () => {
  it('calls process once when text fits', async () => {
    const calls: string[] = []
    const result = await processTextInChunks({
      text: 'hello',
      budget: budget(10),
      process: async (chunk) => {
        calls.push(chunk)
        return chunk.toUpperCase()
      },
      merge: (outs) => outs.join(''),
    })
    expect(calls).toEqual(['hello'])
    expect(result).toBe('HELLO')
  })

  it('splits and merges when text is oversized', async () => {
    const calls: string[] = []
    const text = 'one two three four five'
    const result = await processTextInChunks({
      text,
      budget: budget(2),
      split: 'word',
      count: countTokens,
      process: async (chunk) => {
        calls.push(chunk)
        return chunk.toUpperCase()
      },
      merge: (outs) => outs.join(' '),
    })
    expect(calls.length).toBeGreaterThan(1)
    expect(result).toBe(text.toUpperCase())
  })
})

describe('withTextChunks', () => {
  it('passes small text through unchanged', async () => {
    const inner = defineTool<{ text: string }, { text: string }>({
      name: 'inner',
      version: '1.0.0',
      mdDescription: 'inner',
      invoke: async (env) => withItem(env, { text: `out:${env.item.text}` }),
    })
    const wrapped = withTextChunks(inner, { budget: budget(100), mode: 'auto' })
    const result = await wrapped.invoke(
      { id: 'ex', variables: [], item: { text: 'hello' }, meta: {} },
      ctx,
    )
    expect(result.item.text).toBe('out:hello')
    expect(getVariable(result, VAR_CHUNK_PROCESSOR)).toBeUndefined()
  })

  it('splits large text in chunk mode', async () => {
    const inner = defineTool<{ text: string }, { text: string }>({
      name: 'inner',
      version: '1.0.0',
      mdDescription: 'inner',
      invoke: async (env) => withItem(env, { text: `out:${env.item.text}` }),
    })
    const wrapped = withTextChunks(inner, {
      budget: budget(3),
      mode: 'chunk',
      split: 'word',
      count: countTokens,
      concurrency: 1,
    })
    const result = await wrapped.invoke(
      { id: 'ex', variables: [], item: { text: 'a bb ccc dddd' }, meta: {} },
      ctx,
    )
    expect(result.item.text).toContain('out:a')
    expect(result.item.text).toContain('out:dddd')
    expect(getVariable(result, VAR_CHUNK_PROCESSOR)).toMatchObject({ chunks: expect.any(Number) })
  })

  it('preserves items array for multi-item input', async () => {
    const inner = defineTool<{ text: string }, { text: string }>({
      name: 'inner',
      version: '1.0.0',
      mdDescription: 'inner',
      invoke: async (env) => withItem(env, { text: env.item.text.toUpperCase() }),
    })
    const wrapped = withTextChunks(inner, { budget: budget(100), mode: 'auto' })
    const env: Exchange<{ text: string }> = {
      id: 'ex',
      variables: [],
      item: { text: 'a' },
      items: [{ text: 'b' }, { text: 'c' }],
      meta: {},
    }
    const result = await wrapped.invoke(env, ctx)
    expect(result.items).toEqual([{ text: 'B' }, { text: 'C' }])
  })
})
