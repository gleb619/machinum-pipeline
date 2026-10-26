import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { resolveLlmConfig } from '../src/core/llm-config.js'
import { mockLlmCall } from '../src/core/llm-gate.js'
import {
  OPENROUTER_FREE_DEFAULTS,
  OPENROUTER_FREE_LLM,
  openrouterFree,
} from '../src/core/openrouter-free.js'

const ctx = {} as ToolContext

describe('openrouterFree preset config', () => {
  it('resolves to provider openrouter with model openrouter/free', () => {
    const cfg = resolveLlmConfig({ tool: OPENROUTER_FREE_LLM, defaults: OPENROUTER_FREE_DEFAULTS })
    expect(cfg.provider).toBe('openrouter')
    expect(cfg.model).toBe('openrouter/free')
    expect(cfg.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(cfg.sources.provider).toBe('tool')
    expect(cfg.sources.model).toBe('preset-defaults')
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
      defaults: OPENROUTER_FREE_DEFAULTS,
      env: { MT_LLM_MODEL: 'deepseek/deepseek-chat' },
    })
    expect(env.model).toBe('openrouter/free')
    expect(env.sources.model).toBe('preset-defaults')

    const call = resolveLlmConfig({
      input: { model: 'anthropic/claude-sonnet-4' },
      tool: OPENROUTER_FREE_LLM,
    })
    expect(call.model).toBe('anthropic/claude-sonnet-4')
    expect(call.provider).toBe('openrouter')
  })
})

describe('openrouterFree model precedence (default, not pin)', () => {
  const settingsCtx = (settings: Record<string, unknown>) =>
    ({ run: { global: { settings, env: {} } } }) as unknown as ToolContext

  it('mt.json settings llm.model beats the preset default', async () => {
    const cfg = resolveLlmConfig({
      tool: OPENROUTER_FREE_LLM,
      defaults: OPENROUTER_FREE_DEFAULTS,
      settings: { 'llm.model': 'settings/model' },
    })
    expect(cfg.model).toBe('settings/model')
    expect(cfg.sources.model).toBe('settings')

    const mock = mockLlmCall(['ok'])
    await openrouterFree
      .with({ call: mock })
      .invoke(
        { id: 'ex-test', variables: [], item: { prompt: 'hi' }, meta: {} },
        settingsCtx({ 'llm.model': 'settings/model' }),
      )
    expect(mock.calls[0]?.model).toBe('settings/model')
  })

  it('meta.llm.model beats the preset default', async () => {
    const cfg = resolveLlmConfig({
      tool: OPENROUTER_FREE_LLM,
      defaults: OPENROUTER_FREE_DEFAULTS,
      meta: { llm: { model: 'meta/model' } },
    })
    expect(cfg.model).toBe('meta/model')
    expect(cfg.sources.model).toBe('meta')

    const mock = mockLlmCall(['ok'])
    await openrouterFree.with({ call: mock }).invoke(
      {
        id: 'ex-test',
        variables: [],
        item: { prompt: 'hi' },
        meta: { llm: { model: 'meta/model' } },
      },
      ctx,
    )
    expect(mock.calls[0]?.model).toBe('meta/model')
  })

  it('a model on the tool layer beats the preset default', () => {
    const cfg = resolveLlmConfig({
      tool: { ...OPENROUTER_FREE_LLM, model: 'tool/model' },
      defaults: OPENROUTER_FREE_DEFAULTS,
    })
    expect(cfg.model).toBe('tool/model')
    expect(cfg.sources.model).toBe('tool')
  })

  it('generic MT_LLM_MODEL env sits below the preset default, provider env above', () => {
    const generic = resolveLlmConfig({
      tool: OPENROUTER_FREE_LLM,
      defaults: OPENROUTER_FREE_DEFAULTS,
      env: { MT_LLM_MODEL: 'env/model' },
    })
    expect(generic.model).toBe('openrouter/free')
    expect(generic.sources.model).toBe('preset-defaults')

    const provider = resolveLlmConfig({
      tool: OPENROUTER_FREE_LLM,
      defaults: OPENROUTER_FREE_DEFAULTS,
      env: { MT_OLLAMA_MODEL: 'ollama/model' },
    })
    expect(provider.model).toBe('openrouter/free')
  })
})

describe('openrouterFree gate', () => {
  it('sends the preset model through the prepare slot (offline, mock call)', async () => {
    const mock = mockLlmCall(['free answer'])
    const out = await openrouterFree
      .with({ call: mock })
      .invoke({ id: 'ex-test', variables: [], item: { prompt: 'hi' }, meta: {} }, ctx)
    expect(mock.calls[0]?.model).toBe('openrouter/free')
    expect(mock.calls[0]?.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(out.item).toMatchObject({ content: 'free answer', model: 'openrouter/free' })
    expect(getVariable(out, 'openrouterFree')).toBe(true)
    expect((getVariable(out, 'llmUsage') as { calls: number }).calls).toBe(1)
  })

  it('per-call model / llm override still wins over the preset', async () => {
    const mock = mockLlmCall(['ok'])
    await openrouterFree.with({ call: mock }).invoke(
      {
        id: 'ex-test',
        variables: [],
        item: { prompt: 'hi', model: 'meta-llama/llama-3.3-70b' },
        meta: {},
      },
      ctx,
    )
    expect(mock.calls[0]?.model).toBe('meta-llama/llama-3.3-70b')

    await openrouterFree.with({ call: mock }).invoke(
      {
        id: 'ex-test',
        variables: [],
        item: { prompt: 'hi', llm: { provider: 'openai', model: 'gpt-4o-mini' } },
        meta: {},
      },
      ctx,
    )
    expect(mock.calls[1]?.model).toBe('gpt-4o-mini')
  })
})

describe('openrouterFree llm.use (vault)', () => {
  const vault = {
    version: 1 as const,
    entries: {
      or: {
        provider: 'openrouter' as const,
        apiKey: 'fake-key-1234',
        defaultModel: 'vendor/model-x',
      },
      gpu: { provider: 'ollama' as const, baseUrl: 'http://vault-host:1/v1' },
    },
  }
  const vctx = (use: string) =>
    ({
      run: { global: { settings: { 'llm.use': use }, vault, env: {} } },
    }) as unknown as ToolContext

  it('vault model + key beat the preset default model', async () => {
    const mock = mockLlmCall(['ok'])
    await openrouterFree
      .with({ call: mock })
      .invoke({ id: 'ex-test', variables: [], item: { prompt: 'hi' }, meta: {} }, vctx('@vault/or'))
    expect(mock.calls[0]?.model).toBe('vendor/model-x')
  })

  it('vault entry of another provider => error naming the ref, no secrets', async () => {
    const run = openrouterFree
      .with({ call: mockLlmCall(['ok']) })
      .invoke(
        { id: 'ex-test', variables: [], item: { prompt: 'hi' }, meta: {} },
        vctx('vault://gpu'),
      )
    await expect(run).rejects.toThrow(/vault:\/\/gpu/)
    await expect(run).rejects.not.toThrow(/fake-key/)
  })
})
