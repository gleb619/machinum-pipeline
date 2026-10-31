import { createExchange, getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  VAR_TOKEN_COUNT,
  VAR_TOKEN_HEURISTIC,
  chunkTokenize,
  tokenizeChunk,
  tokenizeChunkDetailed,
} from './chunk-tokens.js'

const ctx = {} as unknown as ToolContext

describe('tokenizeChunk', () => {
  it('returns BPE ids with decoded pieces that rebuild the text', async () => {
    const text = 'Hello world, this is a chunk.'
    const tokens = await tokenizeChunk(text)
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.every((t) => Number.isInteger(t.tokenId))).toBe(true)
    expect(tokens.map((t) => t.text).join('')).toBe(text)
  })

  it('supports an explicit encoding', async () => {
    const tokens = await tokenizeChunk('Hello world', { encoding: 'cl100k_base' })
    expect(tokens.map((t) => t.text).join('')).toBe('Hello world')
  })

  it('returns no tokens for empty text', async () => {
    expect(await tokenizeChunkDetailed('')).toEqual({ tokens: [], heuristic: false })
  })

  it('is not heuristic when gpt-tokenizer is available', async () => {
    expect((await tokenizeChunkDetailed('abc')).heuristic).toBe(false)
  })
})

describe('chunkTokenize tool', () => {
  it('sets tokenCount and tokenHeuristic', async () => {
    const out = await chunkTokenize.invoke(createExchange('One two three four.'), ctx)
    expect(out.item.length).toBeGreaterThan(0)
    expect(getVariable<number>(out, VAR_TOKEN_COUNT)).toBe(out.item.length)
    expect(out.meta.tokenCount).toBe(out.item.length)
    expect(getVariable<boolean>(out, VAR_TOKEN_HEURISTIC)).toBe(false)
  })
})
