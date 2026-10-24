import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cache } from '@mt/core'
import { describe, expect, it, vi } from 'vitest'
import {
  AnthropicClient,
  type CacheLike,
  type LlmClient,
  type LlmHttpRequest,
  type LlmHttpResponse,
  type LlmRequest,
  type LlmTransport,
  OpenAiCompatClient,
  createLlmClient,
} from '../src/core/llm-client.js'
import { resolveLlmConfig } from '../src/core/llm-config.js'
import { withCache, withLlmRetry, withTimeout } from '../src/core/llm-decorators.js'
import {
  LlmAbortError,
  LlmAuthError,
  LlmContextLengthError,
  LlmQuotaError,
  LlmRateLimitError,
  LlmServerError,
  LlmTimeoutError,
} from '../src/core/llm-errors.js'
import { OpenRouterPoolSupplier } from '../src/core/openrouter-pool.js'

const okBody = (content = 'hi', extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    model: 'm-resp',
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, ...extra },
  })

function scripted(responses: Array<LlmHttpResponse | Error>) {
  const seen: LlmHttpRequest[] = []
  const transport: LlmTransport = async (req) => {
    seen.push(req)
    const r = responses[Math.min(seen.length - 1, responses.length - 1)] as LlmHttpResponse | Error
    if (r instanceof Error) throw r
    return r
  }
  return { transport, seen }
}

const req: LlmRequest = { model: 'm', messages: [{ role: 'user', content: 'q' }] }
const fast = { max: 2, backoffMs: 0, strategy: 'fixed' as const }

describe('OpenAiCompatClient', () => {
  it('builds request (system first, json mode, key header) and maps response', async () => {
    const { transport, seen } = scripted([{ status: 200, body: okBody('hello', { cost: 0.01 }) }])
    const c = new OpenAiCompatClient({ baseUrl: 'http://h/v1/', apiKey: 'sk-1', transport })
    const res = await c.chatCompletion({
      ...req,
      system: 'sys',
      temperature: 0.2,
      maxTokens: 9,
      responseFormat: 'json',
    })
    expect(seen[0]?.url).toBe('http://h/v1/chat/completions')
    expect(seen[0]?.headers.Authorization).toBe('Bearer sk-1')
    const body = JSON.parse(seen[0]?.body ?? '{}')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(body.temperature).toBe(0.2)
    expect(body.max_tokens).toBe(9)
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(res).toMatchObject({
      content: 'hello',
      model: 'm-resp',
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, costUsd: 0.01 },
    })
  })

  it('classifies errors', async () => {
    const mk = (status: number, body = 'x', headers: Record<string, string> = {}) =>
      new OpenAiCompatClient({
        baseUrl: 'http://h',
        transport: scripted([{ status, body, headers }]).transport,
      }).chatCompletion(req)
    await expect(mk(429, 'slow', { 'retry-after': '2' })).rejects.toMatchObject({
      name: 'LlmRateLimitError',
      retryAfterMs: 2000,
    })
    await expect(mk(401)).rejects.toBeInstanceOf(LlmAuthError)
    await expect(mk(402)).rejects.toBeInstanceOf(LlmQuotaError)
    await expect(mk(503)).rejects.toBeInstanceOf(LlmServerError)
    await expect(mk(400, 'maximum context length is 8192 tokens')).rejects.toBeInstanceOf(
      LlmContextLengthError,
    )
    await expect(mk(500, 'boom')).rejects.toThrow('Chat completion failed: 500 boom')
  })

  it('network failure becomes retryable LlmNetworkError', async () => {
    const c = new OpenAiCompatClient({
      baseUrl: 'http://h',
      transport: scripted([new TypeError('fetch failed')]).transport,
    })
    await expect(c.chatCompletion(req)).rejects.toMatchObject({
      name: 'LlmNetworkError',
      retryable: true,
    })
  })

  it('pool: rotates keys, blocks 429 key, disables 402 key', async () => {
    const pool = new OpenRouterPoolSupplier({
      clients: [
        { apiKey: 'k1', apiUrl: 'http://p' },
        { apiKey: 'k2', apiUrl: 'http://p' },
      ],
    })
    const { transport, seen } = scripted([
      { status: 429, body: 'rl' },
      { status: 200, body: okBody() },
      { status: 402, body: 'pay' },
      { status: 200, body: okBody() },
    ])
    const c = new OpenAiCompatClient({ baseUrl: 'unused', pool, transport })
    await expect(c.chatCompletion(req)).rejects.toBeInstanceOf(LlmRateLimitError) // k1 blocked
    await c.chatCompletion(req) // k2
    expect(seen.map((s) => s.headers.Authorization)).toEqual(['Bearer k1', 'Bearer k2'])
    expect(pool.getPool().statusCounts().rateLimited).toBe(1)
    await expect(c.chatCompletion(req)).rejects.toBeInstanceOf(LlmQuotaError) // k2 disabled
    expect(pool.getPool().statusCounts()).toMatchObject({
      disabled: 1,
      rateLimited: 1,
      available: 0,
    })
    await expect(c.chatCompletion(req)).rejects.toBeInstanceOf(LlmRateLimitError) // none left
  })
})

describe('AnthropicClient', () => {
  it('maps system/messages/json and response', async () => {
    const { transport, seen } = scripted([
      {
        status: 200,
        body: JSON.stringify({
          content: [
            { type: 'text', text: 'A' },
            { type: 'text', text: 'B' },
          ],
          model: 'claude-x',
          stop_reason: 'end_turn',
          usage: { input_tokens: 4, output_tokens: 6 },
        }),
      },
    ])
    const c = new AnthropicClient({ apiKey: 'ak', transport })
    const res = await c.chatCompletion({
      model: 'claude-x',
      system: 'S1',
      messages: [
        { role: 'system', content: 'S2' },
        { role: 'user', content: 'u' },
      ],
      responseFormat: 'json',
    })
    expect(seen[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(seen[0]?.headers['x-api-key']).toBe('ak')
    const body = JSON.parse(seen[0]?.body ?? '{}')
    expect(body.system).toContain('S1')
    expect(body.system).toContain('S2')
    expect(body.system).toContain('JSON')
    expect(body.messages).toEqual([{ role: 'user', content: 'u' }])
    expect(body.max_tokens).toBe(4096)
    expect(res).toMatchObject({
      content: 'AB',
      finishReason: 'end_turn',
      usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
    })
  })
  it('missing key -> LlmAuthError without leaking anything', async () => {
    await expect(new AnthropicClient({}).chatCompletion(req)).rejects.toBeInstanceOf(LlmAuthError)
  })
})

describe('withLlmRetry', () => {
  it('retries 500 then succeeds', async () => {
    const { transport, seen } = scripted([
      { status: 500, body: 'e' },
      { status: 200, body: okBody('ok') },
    ])
    const onRetry = vi.fn()
    const c = withLlmRetry(new OpenAiCompatClient({ baseUrl: 'http://h', transport }), fast, {
      onRetry,
    })
    expect((await c.chatCompletion(req)).content).toBe('ok')
    expect(seen).toHaveLength(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
  it('retries 429 up to max then throws last error', async () => {
    const { transport, seen } = scripted([{ status: 429, body: 'rl' }])
    const c = withLlmRetry(new OpenAiCompatClient({ baseUrl: 'http://h', transport }), fast)
    await expect(c.chatCompletion(req)).rejects.toBeInstanceOf(LlmRateLimitError)
    expect(seen).toHaveLength(3) // 1 + max(2)
  })
  it('does not retry auth / bad request / context errors', async () => {
    for (const status of [401, 400]) {
      const { transport, seen } = scripted([{ status, body: 'no' }])
      const c = withLlmRetry(new OpenAiCompatClient({ baseUrl: 'http://h', transport }), fast)
      await expect(c.chatCompletion(req)).rejects.toThrow()
      expect(seen).toHaveLength(1)
    }
  })
})

describe('withCache', () => {
  const memory = (): CacheLike & { store: Map<string, unknown> } => {
    const store = new Map<string, unknown>()
    const core = new Cache('/nonexistent')
    return {
      store,
      computeKey: (o) => core.computeKey(o),
      get: async <T>(k: string) => store.get(k) as T | undefined,
      set: async (k, _o, v) => {
        store.set(k, v)
      },
    }
  }

  it('second identical call skips transport', async () => {
    const { transport, seen } = scripted([{ status: 200, body: okBody('once') }])
    const c = withCache(new OpenAiCompatClient({ baseUrl: 'http://h', transport }), memory())
    const a = await c.chatCompletion(req)
    const b = await c.chatCompletion({ ...req, signal: new AbortController().signal, timeoutMs: 5 })
    expect(seen).toHaveLength(1)
    expect(a.cached).toBeUndefined()
    expect(b).toMatchObject({ content: 'once', cached: true })
  })
  it('different request -> miss; key independent of property order', async () => {
    const { transport, seen } = scripted([{ status: 200, body: okBody() }])
    const c = withCache(new OpenAiCompatClient({ baseUrl: 'http://h', transport }), memory())
    await c.chatCompletion({ model: 'm', temperature: 0, messages: req.messages })
    await c.chatCompletion({ temperature: 0, messages: req.messages, model: 'm' })
    await c.chatCompletion({ ...req, model: 'other' })
    expect(seen).toHaveLength(2)
  })
  it('works with the real core Cache on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-cache-'))
    const { transport, seen } = scripted([{ status: 200, body: okBody('disk') }])
    const c = withCache(new OpenAiCompatClient({ baseUrl: 'http://h', transport }), new Cache(dir))
    await c.chatCompletion(req)
    expect((await c.chatCompletion(req)).content).toBe('disk')
    expect(seen).toHaveLength(1)
  })
  it('when() can bypass', async () => {
    const { transport, seen } = scripted([{ status: 200, body: okBody() }])
    const c = withCache(new OpenAiCompatClient({ baseUrl: 'http://h', transport }), memory(), {
      when: () => false,
    })
    await c.chatCompletion(req)
    await c.chatCompletion(req)
    expect(seen).toHaveLength(2)
  })
})

describe('withTimeout / abort', () => {
  const hang: LlmClient = {
    chatCompletion: (r) =>
      new Promise((_, reject) => {
        r.signal?.addEventListener('abort', () => reject(new Error('aborted inner')))
      }),
  }
  it('times out even if inner never settles on its own', async () => {
    await expect(withTimeout(hang, 20).chatCompletion(req)).rejects.toBeInstanceOf(LlmTimeoutError)
  })
  it('per-call timeoutMs overrides default', async () => {
    await expect(
      withTimeout(hang, 10_000).chatCompletion({ ...req, timeoutMs: 15 }),
    ).rejects.toThrow(/timed out after 15ms/)
  })
  it('user AbortSignal aborts (not retryable)', async () => {
    const ac = new AbortController()
    const p = withTimeout(hang, 10_000).chatCompletion({ ...req, signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toBeInstanceOf(LlmAbortError)
    await expect(
      withTimeout(hang, 10_000).chatCompletion({ ...req, signal: ac.signal }),
    ).rejects.toBeInstanceOf(LlmAbortError)
  })
  it('timeouts are retried by the retry decorator', async () => {
    let n = 0
    const flaky: LlmClient = {
      chatCompletion: async (r) => {
        n++
        if (n === 1) return hang.chatCompletion(r)
        return {
          content: 'late',
          model: 'm',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }
      },
    }
    const c = withLlmRetry(withTimeout(flaky, 15), fast)
    expect((await c.chatCompletion(req)).content).toBe('late')
  })
})

describe('createLlmClient', () => {
  it('router provider posts to /api/chat/completions without auth, with retry on 500', async () => {
    const { transport, seen } = scripted([
      { status: 500, body: 'x' },
      { status: 200, body: okBody('routed') },
    ])
    const cfg = resolveLlmConfig({ tool: { retry: fast }, routerUrl: 'http://router:7777' })
    const c = createLlmClient(cfg, undefined, { transport })
    expect((await c.chatCompletion(req)).content).toBe('routed')
    expect(seen[0]?.url).toBe('http://router:7777/api/chat/completions')
    expect(seen[0]?.headers.Authorization).toBeUndefined()
    expect(seen).toHaveLength(2)
  })
  it('cache enabled via config skips transport on 2nd call', async () => {
    const { transport, seen } = scripted([{ status: 200, body: okBody('c') }])
    const dir = mkdtempSync(join(tmpdir(), 'llm-cache-'))
    const cfg = resolveLlmConfig({ tool: { cache: true, retry: fast } })
    const c = createLlmClient(cfg, undefined, { transport, cache: new Cache(dir) })
    await c.chatCompletion(req)
    await c.chatCompletion(req)
    expect(seen).toHaveLength(1)
  })
  it('openai provider sends bearer key from env', async () => {
    const { transport, seen } = scripted([{ status: 200, body: okBody() }])
    const cfg = resolveLlmConfig({ env: { MT_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-env' } })
    await createLlmClient(cfg, undefined, { transport }).chatCompletion(req)
    expect(seen[0]?.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(seen[0]?.headers.Authorization).toBe('Bearer sk-env')
  })
  it('error messages never contain the api key', async () => {
    const { transport } = scripted([{ status: 401, body: 'bad key' }])
    const cfg = resolveLlmConfig({ tool: { provider: 'openai', apiKey: 'sk-topsecret' } })
    const err = await createLlmClient(cfg, undefined, { transport })
      .chatCompletion(req)
      .catch((e: Error) => e)
    expect(String(err)).not.toContain('sk-topsecret')
  })
})
