import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { resolveLlmConfig } from '../src/core/llm-config.js'
import { mockLlmCall } from '../src/core/llm-gate.js'
import { OPENROUTER_FREE_LLM, openrouterFree } from '../src/core/openrouter-free.js'

const ctx = {} as ToolContext

describe('openrouterFree preset config', () => {
  it('resolves to provider openrouter with model openrouter/free', () => {
    const cfg = resolveLlmConfig({ tool: OPENROUTER_FREE_LLM })
    expect(cfg.provider).toBe('openrouter')
    expect(cfg.model).toBe('openrouter/free')
    expect(cfg.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(cfg.sources.provider).toBe('tool')
    expect(cfg.sources.model).toBe('tool')
  })

  it('takes the key from OPENROUTER_API_KEYS (pool) or OPENROUTER_API_KEY', () => {
    const pool = resolveLlmConfig({
      tool: OPENROUTER_FREE_LLM,
      env: { OPENROUTER_API_KEYS: 'key-a, key-b' },
    })
    expect(pool.apiKeys).toEqual(['key-a', 'key-b'])
    expect(pool.apiKey).toBe('key-a')
    expect(pool.sources.apiKey).toBe('env')

    const single = resolveLlmConfig({
      tool: OPENROUTER_FREE_LLM,
      env: { OPENROUTER_API_KEY: 'key-c' },
    })
    expect(single.apiKeys).toEqual(['key-c'])
  })

  it('stays below per-call overrides, above env', () => {
    const env = resolveLlmConfig({
      tool: OPENROUTER_FREE_LLM,
      env: { MT_LLM_MODEL: 'deepseek/deepseek-chat' },
    })
    expect(env.model).toBe('openrouter/free')

    const call = resolveLlmConfig({
      input: { model: 'anthropic/claude-sonnet-4' },
      tool: OPENROUTER_FREE_LLM,
    })
    expect(call.model).toBe('anthropic/claude-sonnet-4')
    expect(call.provider).toBe('openrouter')
  })
})

describe('openrouterFree gate', () => {
  it('sends the preset model through the prepare slot (offline, mock call)', async () => {
    const mock = mockLlmCall(['free answer'])
    const out = await openrouterFree
      .with({ call: mock })
      .invoke({ item: { prompt: 'hi' }, meta: {} }, ctx)
    expect(mock.calls[0]?.model).toBe('openrouter/free')
    expect(mock.calls[0]?.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(out.item).toMatchObject({ content: 'free answer', model: 'openrouter/free' })
    expect(out.meta.openrouterFree).toBe(true)
    expect((out.meta.llmUsage as { calls: number }).calls).toBe(1)
  })

  it('per-call model / llm override still wins over the preset', async () => {
    const mock = mockLlmCall(['ok'])
    await openrouterFree
      .with({ call: mock })
      .invoke({ item: { prompt: 'hi', model: 'meta-llama/llama-3.3-70b' }, meta: {} }, ctx)
    expect(mock.calls[0]?.model).toBe('meta-llama/llama-3.3-70b')

    await openrouterFree
      .with({ call: mock })
      .invoke(
        { item: { prompt: 'hi', llm: { provider: 'openai', model: 'gpt-4o-mini' } }, meta: {} },
        ctx,
      )
    expect(mock.calls[1]?.model).toBe('gpt-4o-mini')
  })
})
