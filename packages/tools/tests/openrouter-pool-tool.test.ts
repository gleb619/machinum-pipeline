import { createExchange, getVariable, setVariable } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmQuotaError, LlmRateLimitError, LlmRequestError } from '../src/core/llm-errors.js'
import { mockLlmCall, mockLlmClient } from '../src/core/llm-gate.js'
import {
  createOpenrouterPool,
  openrouterPool,
  resetOpenrouterPoolPins,
} from '../src/core/openrouter-pool-tool.js'

const ctx = {} as ToolContext
const envOf = (item: Record<string, unknown>) => createExchange(item)
const notFound = () =>
  new LlmRequestError('Chat completion failed: 404 no endpoints', { status: 404 })

interface PoolMeta {
  model: string
  pinnedAt: number
  repins: number
}
const poolMeta = (e: { variables: Parameters<typeof getVariable>[0]['variables'] }) =>
  getVariable(e, 'openrouterPool') as PoolMeta

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
    expect(poolMeta(last)).toMatchObject({ model: 'openrouter/free', repins: 0 })
    expect(typeof poolMeta(last).pinnedAt).toBe('number')
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
    expect(poolMeta(out).repins).toBe(0)
  })

  it('a model from any layer above the preset defaults beats the pin and never creates one', async () => {
    const settingsCtx = (settings: Record<string, unknown>) =>
      ({ run: { global: { settings, env: {} } } }) as unknown as ToolContext
    const cases: Array<{
      name: string
      env: Exchange<Record<string, unknown>>
      ctx: ToolContext
      model: string
    }> = [
      {
        name: 'mt.json settings llm.model',
        env: envOf({ prompt: 'x' }),
        ctx: settingsCtx({ 'llm.model': 'settings/model' }),
        model: 'settings/model',
      },
      {
        name: 'llm variable model',
        env: setVariable(envOf({ prompt: 'x' }), 'llm', { model: 'meta/model' }),
        ctx,
        model: 'meta/model',
      },
      {
        name: 'legacy meta.llm.model',
        env: createExchange({ prompt: 'x' }, { meta: { llm: { model: 'meta/model' } } }),
        ctx,
        model: 'meta/model',
      },
      {
        name: 'per-call llm.model',
        env: envOf({ prompt: 'x', llm: { model: 'call/model' } }),
        ctx,
        model: 'call/model',
      },
    ]

    for (const c of cases) {
      resetOpenrouterPoolPins()
      const mock = mockLlmCall(['ok'])
      const gate = openrouterPool.with({ call: mock })
      const out = await gate.invoke(c.env, c.ctx)
      expect(mock.calls.map((r) => r.model)).toEqual([c.model])
      // No pin was created for this key-set: `emit` records the `openrouterPool` variable only when a pin exists.
      expect(getVariable(out, 'openrouterPool')).toBeUndefined()

      // A later call with no model layer still pins the first candidate, from scratch (repins 0).
      const next = await gate.invoke(envOf({ prompt: 'y' }), ctx)
      expect(mock.calls.at(-1)?.model).toBe('openrouter/free')
      expect(poolMeta(next)).toMatchObject({ model: 'openrouter/free', repins: 0 })
    }
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
    expect(poolMeta(out)).toMatchObject({ model: 'm/two', repins: 1 })
    // later calls stay on the new pin
    await gate.invoke(envOf({ prompt: 'y' }), ctx)
    expect(client.calls.at(-1)?.model).toBe('m/two')
  })

  it('does not re-pin on success', async () => {
    const { out, client } = await run([])
    expect(client.calls).toHaveLength(1)
    expect(poolMeta(out).repins).toBe(0)
  })

  it('re-pins on exhausted rate limit (no live keys) and on quota error', async () => {
    const rl = await run([new LlmRateLimitError('429')])
    expect(poolMeta(rl.out)).toMatchObject({ model: 'm/two', repins: 1 })
    resetOpenrouterPoolPins()
    const q = await run([new LlmQuotaError('402')])
    expect(poolMeta(q.out)).toMatchObject({ model: 'm/two', repins: 1 })
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
    expect(poolMeta(out)).toMatchObject({ model: 'm/one', repins: 0 })
  })
})

describe('openrouterPool llm.use (vault)', () => {
  it('vault model is used instead of the sticky pin', async () => {
    const vctx = {
      run: {
        global: {
          settings: { 'llm.use': 'vault://or' },
          vault: {
            version: 1,
            entries: {
              or: {
                provider: 'openrouter',
                apiKey: 'fake-key-1234',
                defaultModel: 'vendor/model-x',
              },
            },
          },
          env: {},
        },
      },
    } as unknown as ToolContext
    const mock = mockLlmCall(['ok'])
    await openrouterPool.with({ call: mock }).invoke(envOf({ prompt: 'x' }), vctx)
    expect(mock.calls[0]?.model).toBe('vendor/model-x')
    // The vault ref sits above the preset defaults: no sticky pin is created.
    const out = await openrouterPool.with({ call: mock }).invoke(envOf({ prompt: 'y' }), vctx)
    expect(getVariable(out, 'openrouterPool')).toBeUndefined()
  })
})
