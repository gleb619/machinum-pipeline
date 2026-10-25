import type { ToolContext } from '@mt/core'
import { describe, expect, it, vi } from 'vitest'
import { resolveLlmConfig } from '../src/core/llm-config.js'
import { mockLlmCall } from '../src/core/llm-gate.js'
import {
  OLLAMA_BASE_URL,
  OLLAMA_DEFAULTS,
  OLLAMA_LLM,
  OLLAMA_MODEL,
  listOllamaModels,
  ollamaApiRoot,
  ollamaHealth,
  ollamaTool,
} from '../src/core/ollama-tool.js'

/** Ctx without ambient env: the empty strings mask `process.env` for the ollama vars. */
const ctx = {
  run: { global: { env: { MT_OLLAMA_MODEL: '', MT_OLLAMA_URL: '' } } },
} as unknown as ToolContext

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response
}

describe('ollamaTool preset config', () => {
  it('resolves to provider ollama with the remote GPU server endpoint', () => {
    const cfg = resolveLlmConfig({ tool: OLLAMA_LLM, defaults: OLLAMA_DEFAULTS })
    expect(cfg.provider).toBe('ollama')
    expect(cfg.baseUrl).toBe('http://localhost:11434/v1')
    expect(cfg.baseUrl).toBe(OLLAMA_BASE_URL)
    expect(cfg.model).toBe('gemma4:latest')
    expect(cfg.model).toBe(OLLAMA_MODEL)
    expect(cfg.transport).toBe('fetch')
    expect(cfg.sources.provider).toBe('tool')
    expect(cfg.sources.baseUrl).toBe('preset-defaults')
    expect(cfg.sources.model).toBe('preset-defaults')
  })

  it('MT_OLLAMA_URL / MT_OLLAMA_MODEL override the preset defaults', () => {
    const cfg = resolveLlmConfig({
      tool: OLLAMA_LLM,
      defaults: OLLAMA_DEFAULTS,
      env: { MT_OLLAMA_URL: 'http://other:11434/v1', MT_OLLAMA_MODEL: 'qwen3:8b' },
    })
    expect(cfg.baseUrl).toBe('http://other:11434/v1')
    expect(cfg.model).toBe('qwen3:8b')
    expect(cfg.sources.baseUrl).toBe('provider-env')
    expect(cfg.sources.model).toBe('provider-env')
  })

  it('per-call input wins over env and preset defaults', () => {
    const cfg = resolveLlmConfig({
      input: { baseUrl: 'http://call:1/v1', model: 'call-model' },
      tool: OLLAMA_LLM,
      defaults: OLLAMA_DEFAULTS,
      env: { MT_OLLAMA_URL: 'http://env:2/v1', MT_OLLAMA_MODEL: 'env-model' },
    })
    expect(cfg.baseUrl).toBe('http://call:1/v1')
    expect(cfg.model).toBe('call-model')
    expect(cfg.sources.baseUrl).toBe('input')
    expect(cfg.sources.model).toBe('input')
  })

  it('keeps the generic ollama provider default untouched', () => {
    expect(resolveLlmConfig({ tool: { provider: 'ollama' } }).baseUrl).toBe(
      'http://localhost:11434/v1',
    )
  })
})

describe('ollamaTool gate', () => {
  it('sends the preset model through the prepare slot (offline, mock call)', async () => {
    const mock = mockLlmCall(['gpu answer'])
    const out = await ollamaTool
      .with({ call: mock })
      .invoke({ item: { prompt: 'hi' }, meta: {} }, ctx)
    expect(mock.calls[0]?.model).toBe(OLLAMA_MODEL)
    expect(mock.calls[0]?.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(out.item).toMatchObject({ content: 'gpu answer', model: OLLAMA_MODEL })
    expect(out.meta.ollama).toBe(true)
    expect((out.meta.llmUsage as { calls: number }).calls).toBe(1)
  })

  it('per-call model override still wins over the preset', async () => {
    const mock = mockLlmCall(['ok'])
    await ollamaTool
      .with({ call: mock })
      .invoke({ item: { prompt: 'hi', model: 'qwen3:8b' }, meta: {} }, ctx)
    expect(mock.calls[0]?.model).toBe('qwen3:8b')
  })
})

describe('ollama native API helpers', () => {
  it('ollamaApiRoot drops the /v1 suffix', () => {
    expect(ollamaApiRoot('http://localhost:11434/v1')).toBe('http://localhost:11434')
    expect(ollamaApiRoot('http://localhost:11434/v1/')).toBe('http://localhost:11434')
    expect(ollamaApiRoot('http://localhost:11434')).toBe('http://localhost:11434')
  })

  it('listOllamaModels parses GET /api/tags', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        models: [
          {
            name: 'gemma4:latest',
            size: 4_200_000_000,
            digest: 'sha256:abc',
            modified_at: '2026-10-01T10:00:00Z',
          },
          { model: 'qwen3:8b' },
        ],
      }),
    )
    const models = await listOllamaModels(OLLAMA_BASE_URL, {
      fetch: fetchMock as unknown as typeof fetch,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.objectContaining({ signal: expect.anything() }),
    )
    expect(models).toEqual([
      {
        name: 'gemma4:latest',
        sizeBytes: 4_200_000_000,
        digest: 'sha256:abc',
        modifiedAt: '2026-10-01T10:00:00Z',
      },
      { name: 'qwen3:8b' },
    ])
  })

  it('ollamaHealth reports ok with the server version', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: '0.5.7' }))
    const health = await ollamaHealth(OLLAMA_BASE_URL, {
      fetch: fetchMock as unknown as typeof fetch,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/version',
      expect.objectContaining({ signal: expect.anything() }),
    )
    expect(health.ok).toBe(true)
    expect(health.version).toBe('0.5.7')
    expect(health.baseUrl).toBe('http://localhost:11434')
  })

  it('ollamaHealth is false on ECONNREFUSED', async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
          code: 'ECONNREFUSED',
        }),
      })
    })
    const health = await ollamaHealth(OLLAMA_BASE_URL, {
      fetch: fetchMock as unknown as typeof fetch,
    })
    expect(health.ok).toBe(false)
    expect(health.error).toContain('ECONNREFUSED')
  })
})

describe('ollamaTool llm.use (vault)', () => {
  const vault = {
    version: 1 as const,
    entries: {
      gpu: {
        provider: 'ollama' as const,
        baseUrl: 'http://vault-host:1/v1',
        defaultModel: 'llama3',
      },
      or: { provider: 'openrouter' as const, apiKey: 'fake-key-1234' },
    },
  }
  const vctx = (use: string) =>
    ({
      run: {
        global: {
          settings: { 'llm.use': use },
          vault,
          env: { MT_OLLAMA_MODEL: '', MT_OLLAMA_URL: '' },
        },
      },
    }) as unknown as ToolContext

  it('vault model beats the preset default', async () => {
    const mock = mockLlmCall(['ok'])
    await ollamaTool
      .with({ call: mock })
      .invoke({ item: { prompt: 'hi' }, meta: {} }, vctx('@vault/gpu'))
    expect(mock.calls[0]?.model).toBe('llama3')
  })

  it('ref model wins; per-call model still beats the ref', async () => {
    const mock = mockLlmCall(['ok'])
    const gate = ollamaTool.with({ call: mock })
    await gate.invoke({ item: { prompt: 'hi' }, meta: {} }, vctx('vault://gpu/qwen3:8b'))
    await gate.invoke({ item: { prompt: 'hi', model: 'call' }, meta: {} }, vctx('vault://gpu'))
    expect(mock.calls.map((c) => c.model)).toEqual(['qwen3:8b', 'call'])
  })

  it('entry with another provider => error naming the ref', async () => {
    const run = ollamaTool
      .with({ call: mockLlmCall(['ok']) })
      .invoke({ item: { prompt: 'hi' }, meta: {} }, vctx('vault://or'))
    await expect(run).rejects.toThrow(/vault:\/\/or/)
  })
})
