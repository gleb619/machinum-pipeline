import type { Vault } from '@mt/core'
import { describe, expect, it, vi } from 'vitest'
import { createAdapter } from '../src/core/llm-client.js'
import { resolveLlmConfig } from '../src/core/llm-config.js'
import { ROUTER_FREE_MODEL, listRouterModels } from '../src/core/router-models.js'

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => body } as unknown as Response
}

describe('listRouterModels', () => {
  it('maps the OpenAI list shape', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) =>
      jsonResponse({
        object: 'list',
        data: [
          { id: 'openrouter/free', object: 'model', owned_by: 'openrouter' },
          { id: 'ollama/gemma4:latest', object: 'model' },
          { object: 'model' },
        ],
      }),
    )
    const out = await listRouterModels('http://r:1/', { fetch: f as unknown as typeof fetch })
    expect(out).toEqual([
      { id: 'openrouter/free', ownedBy: 'openrouter' },
      { id: 'ollama/gemma4:latest' },
    ])
    expect(f.mock.calls[0]?.[0]).toBe('http://r:1/api/models')
  })

  it('sends token only when given; error omits it', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => jsonResponse({}, 401))
    await expect(
      listRouterModels('http://r:1', { token: 'fake-tok', fetch: f as unknown as typeof fetch }),
    ).rejects.toThrow(/401/)
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-tok')
    await expect(
      listRouterModels('http://r:1', { token: 'fake-tok', fetch: f as unknown as typeof fetch }),
    ).rejects.not.toThrow(/fake-tok/)
    const g = vi.fn(async (_u: string, _i?: RequestInit) => jsonResponse({ data: [] }))
    await listRouterModels('http://r:1', { fetch: g as unknown as typeof fetch })
    const init2 = (g.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init2.headers).toEqual({})
  })
})

describe('provider router is keyless; vault router entry', () => {
  const vault: Vault = {
    version: 1,
    entries: {
      rt: {
        provider: 'router',
        baseUrl: 'http://router-host:7777',
        defaultModel: ROUTER_FREE_MODEL,
      },
      rtok: { provider: 'router', baseUrl: 'http://router-host:7777', apiKey: 'fake-router-token' },
    },
  }

  it('resolves without any api key and with the alias model', () => {
    const c = resolveLlmConfig({ settings: { 'llm.use': 'vault://rt' }, vault })
    expect(c.provider).toBe('router')
    expect(c.baseUrl).toBe('http://router-host:7777')
    expect(c.model).toBe('openrouter/free')
    expect(c.apiKey).toBeUndefined()
    expect(
      resolveLlmConfig({ settings: { 'llm.use': 'vault://rt/ollama/gemma4:latest' }, vault }).model,
    ).toBe('ollama/gemma4:latest')
    expect(resolveLlmConfig({}).apiKey).toBeUndefined()
  })

  it('calls the fake router at /api/chat/completions; token optional', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    const transport = async (req: {
      url: string
      headers: Record<string, string>
      body: string
    }) => {
      seen.push(req)
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: 'hi' } }],
          model: 'openrouter/free',
        }),
      }
    }
    for (const entry of ['rt', 'rtok']) {
      const cfg = resolveLlmConfig({ settings: { 'llm.use': `vault://${entry}` }, vault })
      const client = createAdapter(cfg, transport as never)
      const r = await client.chatCompletion({
        model: cfg.model,
        messages: [{ role: 'user', content: 'x' }],
      })
      expect(r.content).toBe('hi')
    }
    expect(seen[0]?.url).toBe('http://router-host:7777/api/chat/completions')
    expect(JSON.parse(seen[0]?.body ?? '{}').model).toBe('openrouter/free')
    expect(seen[0]?.headers.Authorization).toBeUndefined()
    expect(seen[1]?.headers.Authorization).toBe('Bearer fake-router-token')
  })
})
