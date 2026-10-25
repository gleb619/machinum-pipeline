import type { ToolContext } from '@mt/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmQuotaError, LlmRateLimitError, LlmRequestError } from '../src/core/llm-errors.js'
import { mockLlmCall, mockLlmClient } from '../src/core/llm-gate.js'
import {
  createOpenrouterPool,
  openrouterPool,
  resetOpenrouterPoolPins,
} from '../src/core/openrouter-pool-tool.js'

const ctx = {} as ToolContext
const envOf = (item: Record<string, unknown>) => ({ item, meta: {} })
const notFound = () =>
  new LlmRequestError('Chat completion failed: 404 no endpoints', { status: 404 })

interface PoolMeta {
  model: string
  pinnedAt: number
  repins: number
}
const poolMeta = (m: Record<string, unknown>) => m.openrouterPool as PoolMeta

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEYS', '')
  vi.stubEnv('OPENROUTER_API_KEY', '')
  resetOpenrouterPoolPins()
})

describe('openrouterPool sticky pin', () => {
  it('defaults to openrouter/free and stays pinned across N calls', async () => {
    const mock = mockLlmCall(['a'])
    const gate = openrouterPool.with({ call: mock })
    let last = await gate.invoke(envOf({ prompt: 'x' }), ctx)
    for (let i = 0; i < 4; i++) last = await gate.invoke(envOf({ prompt: 'x' }), ctx)
    expect(mock.calls.map((c) => c.model)).toEqual(Array(5).fill('openrouter/free'))
    expect(poolMeta(last.meta)).toMatchObject({ model: 'openrouter/free', repins: 0 })
    expect(typeof poolMeta(last.meta).pinnedAt).toBe('number')
  })

  it('first strategy pins first candidate; shared across gate instances', async () => {
    const a = createOpenrouterPool({ models: ['m/one:free', 'm/two:free'] })
    const b = createOpenrouterPool({ models: ['m/one:free', 'm/two:free'] })
    const mock = mockLlmCall(['ok'])
    await a.with({ call: mock }).invoke(envOf({ prompt: 'x' }), ctx)
    await b.with({ call: mock }).invoke(envOf({ prompt: 'x' }), ctx)
    expect(mock.calls.map((c) => c.model)).toEqual(['m/one:free', 'm/one:free'])
  })

  it('random strategy picks one candidate and keeps it', async () => {
    const models = ['m/a', 'm/b', 'm/c']
    const gate = createOpenrouterPool({ models, strategy: 'random' })
    const mock = mockLlmCall(['ok'])
    for (let i = 0; i < 6; i++) await gate.with({ call: mock }).invoke(envOf({ prompt: 'x' }), ctx)
    const seen = new Set(mock.calls.map((c) => c.model))
    expect(seen.size).toBe(1)
    expect(models).toContain([...seen][0])
  })

  it('per-call llm.model override wins and does not change the pin', async () => {
    const mock = mockLlmCall(['ok'])
    const gate = openrouterPool.with({ call: mock })
    await gate.invoke(envOf({ prompt: 'x', model: 'other/model' }), ctx)
    const out = await gate.invoke(envOf({ prompt: 'x' }), ctx)
    expect(mock.calls.map((c) => c.model)).toEqual(['other/model', 'openrouter/free'])
    expect(poolMeta(out.meta).repins).toBe(0)
  })
})

describe('openrouterPool re-pin', () => {
  const run = async (errors: Error[], models = ['m/one', 'm/two', 'm/three']) => {
    const client = mockLlmClient((req, i) => {
      const err = i < errors.length ? errors[i] : undefined
      return err ?? `ok from ${req.model}`
    })
    const gate = createOpenrouterPool({ models, client: () => client })
    const out = await gate.invoke(envOf({ prompt: 'x' }), ctx)
    return { client, gate, out }
  }

  it('re-pins to the next candidate on 404 and retries', async () => {
    const { client, gate, out } = await run([notFound()])
    expect(client.calls.map((c) => c.model)).toEqual(['m/one', 'm/two'])
    expect((out.item as { content: string }).content).toBe('ok from m/two')
    expect(poolMeta(out.meta)).toMatchObject({ model: 'm/two', repins: 1 })
    // later calls stay on the new pin
    await gate.invoke(envOf({ prompt: 'y' }), ctx)
    expect(client.calls.at(-1)?.model).toBe('m/two')
  })

  it('does not re-pin on success', async () => {
    const { out, client } = await run([])
    expect(client.calls).toHaveLength(1)
    expect(poolMeta(out.meta).repins).toBe(0)
  })

  it('re-pins on exhausted rate limit (no live keys) and on quota error', async () => {
    const rl = await run([new LlmRateLimitError('429')])
    expect(poolMeta(rl.out.meta)).toMatchObject({ model: 'm/two', repins: 1 })
    resetOpenrouterPoolPins()
    const q = await run([new LlmQuotaError('402')])
    expect(poolMeta(q.out.meta)).toMatchObject({ model: 'm/two', repins: 1 })
  })

  it('throws once every candidate failed', async () => {
    await expect(run([notFound(), notFound(), notFound()])).rejects.toThrow(/404/)
  })

  it('does not re-pin on unrelated errors', async () => {
    await expect(run([new LlmRequestError('bad', { status: 400 })])).rejects.toThrow('bad')
  })

  it('404 on a per-call override model does not touch the pin', async () => {
    const client = mockLlmClient((req) => (req.model === 'bad/model' ? notFound() : 'ok'))
    const gate = createOpenrouterPool({ models: ['m/one', 'm/two'], client: () => client })
    await expect(gate.invoke(envOf({ prompt: 'x', model: 'bad/model' }), ctx)).rejects.toThrow()
    const out = await gate.invoke(envOf({ prompt: 'x' }), ctx)
    expect(poolMeta(out.meta)).toMatchObject({ model: 'm/one', repins: 0 })
  })
})
