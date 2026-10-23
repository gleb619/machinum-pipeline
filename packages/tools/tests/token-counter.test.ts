import type { Envelope, ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import { tokenCounter, tokenCounterBatch, tokenCounterBatchCached } from '../src/token-counter.js'

const ctx = {} as ToolContext

describe('tokenCounter', () => {
  it('counts tokens', async () => {
    const env: Envelope<string> = { item: 'hello world', meta: {} }
    const res = await tokenCounter.invoke(env, ctx)
    expect(res.meta.tokenCount).toBeGreaterThan(0)
    expect(res.item).toBe('hello world')
  })
})

describe('tokenCounterBatch', () => {
  it('counts tokens per item and as batch total', async () => {
    const env: Envelope<string> = { item: '', items: ['hello world', 'foo bar'], meta: {} }
    const res = await tokenCounterBatch.invoke(env, ctx)
    const counts = res.meta.tokenCounts as number[]
    expect(counts).toHaveLength(2)
    for (const c of counts) {
      expect(c).toBeGreaterThan(0)
    }
    expect(res.meta.tokenCount).toBe(counts.reduce((sum, n) => sum + n, 0))
    expect(res.items).toEqual(['hello world', 'foo bar'])
  })
})

describe('tokenCounterBatchCached', () => {
  it('counts tokens per item and as batch total', async () => {
    const env: Envelope<string> = { item: '', items: ['hello world', 'foo bar'], meta: {} }
    const res = await tokenCounterBatchCached.invoke(env, ctx)
    const counts = res.meta.tokenCounts as number[]
    expect(counts).toHaveLength(2)
    expect(res.meta.tokenCount).toBe(counts.reduce((sum, n) => sum + n, 0))
  })

  it('reuses the encoder across invocations and counts consistently', async () => {
    const env: Envelope<string> = { item: '', items: ['same input'], meta: {} }
    const first = await tokenCounterBatchCached.invoke(env, ctx)
    const second = await tokenCounterBatchCached.invoke(env, ctx)
    expect(second.meta.tokenCount).toBe(first.meta.tokenCount)
    expect(second.meta.tokenCount).toBeGreaterThan(0)
  })
})
