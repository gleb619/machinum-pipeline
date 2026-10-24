import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmRequest } from '../src/llm-client.js'
import { resolveLlmConfig } from '../src/llm-config.js'
import { withCache } from '../src/llm-decorators.js'
import {
  LlmAbortError,
  LlmAuthError,
  LlmContextLengthError,
  LlmNetworkError,
  LlmQuotaError,
  LlmRateLimitError,
  LlmServerError,
  LlmTimeoutError,
} from '../src/llm-errors.js'
import {
  createAnthropicSdkClient,
  createOpenAiSdkClient,
  defaultTransportKind,
  mapSdkError,
} from '../src/llm-sdk-transports.js'
import { OpenRouterPoolSupplier } from '../src/openrouter-pool.js'

// ---------------------------------------------------------------------------
// Mock SDKs (vi.mock intercepts the adapters' dynamic imports)
// ---------------------------------------------------------------------------

class FakeApiError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers,
    readonly error?: unknown,
  ) {
    super(`API error ${status}`)
    this.name = 'APIError'
  }
}

class FakeApiUserAbortError extends Error {
  constructor() {
    super('aborted')
    this.name = 'APIUserAbortError'
  }
}

class FakeApiConnectionTimeoutError extends Error {
  constructor() {
    super('timed out')
    this.name = 'APIConnectionTimeoutError'
  }
}

class FakeApiConnectionError extends Error {
  constructor() {
    super('connection failed')
    this.name = 'APIConnectionError'
  }
}

const openAiCreate = vi.hoisted(() => vi.fn())
const openAiConstructor = vi.hoisted(() => vi.fn())

vi.mock('openai', () => {
  class MockOpenAI {
    chat = { completions: { create: openAiCreate } }
    constructor(options: unknown) {
      openAiConstructor(options)
    }
  }
  return { default: MockOpenAI }
})

const anthropicCreate = vi.hoisted(() => vi.fn())
const anthropicConstructor = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: anthropicCreate }
    constructor(options: unknown) {
      anthropicConstructor(options)
    }
  }
  return { default: MockAnthropic }
})

const req: LlmRequest = { model: 'm', messages: [{ role: 'user', content: 'q' }] }

function okOpenAi(content = 'ok') {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    model: 'm-resp',
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }
}

beforeEach(() => {
  openAiCreate.mockReset()
  openAiConstructor.mockReset()
  anthropicCreate.mockReset()
  anthropicConstructor.mockReset()
})

// ---------------------------------------------------------------------------
// mapSdkError (pure duck-typing, no SDK needed)
// ---------------------------------------------------------------------------

describe('mapSdkError', () => {
  it('maps statuses onto the shared typed errors', () => {
    const mk = (status: number, body = 'x', headers: Record<string, string> = {}) =>
      mapSdkError(new FakeApiError(status, new Headers(headers), { message: body }), 1000)
    const rl = mk(429, 'slow', { 'retry-after': '2' })
    expect(rl).toBeInstanceOf(LlmRateLimitError)
    expect((rl as LlmRateLimitError).retryAfterMs).toBe(2000)
    expect(mk(401)).toBeInstanceOf(LlmAuthError)
    expect(mk(403)).toBeInstanceOf(LlmAuthError)
    expect(mk(402)).toBeInstanceOf(LlmQuotaError)
    expect(mk(503)).toBeInstanceOf(LlmServerError)
    expect(mk(400, 'maximum context length exceeded')).toBeInstanceOf(LlmContextLengthError)
    expect(mk(418)).toMatchObject({ name: 'LlmRequestError', retryable: false })
  })

  it('maps abort / timeout / connection errors', () => {
    expect(mapSdkError(new FakeApiUserAbortError(), 1000)).toBeInstanceOf(LlmAbortError)
    const to = mapSdkError(new FakeApiConnectionTimeoutError(), 1500)
    expect(to).toBeInstanceOf(LlmTimeoutError)
    expect(to.message).toContain('1500ms')
    expect(mapSdkError(new FakeApiConnectionError(), 1000)).toBeInstanceOf(LlmNetworkError)
    expect(mapSdkError(new TypeError('fetch failed'), 1000)).toBeInstanceOf(LlmNetworkError)
  })

  it('passes through already-typed LlmErrors', () => {
    const err = new LlmRateLimitError('x', { retryAfterMs: 5 })
    expect(mapSdkError(err, 1000)).toBe(err)
  })
})

// ---------------------------------------------------------------------------
// defaultTransportKind + resolveLlmConfig transport key
// ---------------------------------------------------------------------------

describe('transport selection', () => {
  it('router stays on fetch; others use the SDK only when resolvable', () => {
    expect(defaultTransportKind('router', () => true)).toBe('fetch')
    expect(defaultTransportKind('openai', () => true)).toBe('sdk')
    expect(defaultTransportKind('openai', () => false)).toBe('fetch')
    expect(defaultTransportKind('anthropic', () => true)).toBe('sdk')
    expect(defaultTransportKind('anthropic', () => false)).toBe('fetch')
    expect(defaultTransportKind('ollama', () => false)).toBe('fetch')
  })

  it('resolveLlmConfig: env + settings + default', () => {
    const c = resolveLlmConfig({ env: { MT_LLM_TRANSPORT: 'fetch' } })
    expect(c.transport).toBe('fetch')
    expect(c.sources.transport).toBe('env')
    const s = resolveLlmConfig({ settings: { 'llm.transport': 'sdk' } })
    expect(s.transport).toBe('sdk')
    expect(s.sources.transport).toBe('settings')
    // openai provider with the installed SDK -> sdk default; router -> fetch
    expect(resolveLlmConfig({ tool: { provider: 'openai' } }).transport).toBe('sdk')
    expect(resolveLlmConfig().transport).toBe('fetch')
    expect(() => resolveLlmConfig({ env: { MT_LLM_TRANSPORT: 'bogus' } })).toThrow(
      /Unknown LLM transport/,
    )
  })
})

// ---------------------------------------------------------------------------
// OpenAI SDK adapter
// ---------------------------------------------------------------------------

describe('createOpenAiSdkClient', () => {
  it('lazy-loads the SDK only on the first call', async () => {
    const c = createOpenAiSdkClient({ apiKey: 'sk', baseUrl: 'http://x/v1' })
    expect(openAiConstructor).not.toHaveBeenCalled()
    openAiCreate.mockResolvedValueOnce(okOpenAi('hi'))
    const res = await c.chatCompletion(req)
    expect(openAiConstructor).toHaveBeenCalledTimes(1)
    expect(openAiConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk', baseURL: 'http://x/v1', maxRetries: 0 }),
    )
    expect(res).toMatchObject({ content: 'hi', model: 'm-resp' })
    expect(res.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 })
    const params = openAiCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(params.model).toBe('m')
  })

  it('maps SDK errors (429 retry-after, 402, 401, context 400, 5xx)', async () => {
    const c = createOpenAiSdkClient({})
    openAiCreate.mockRejectedValueOnce(
      new FakeApiError(429, new Headers({ 'retry-after': '3' }), { message: 'slow' }),
    )
    await expect(c.chatCompletion(req)).rejects.toMatchObject({
      name: 'LlmRateLimitError',
      retryAfterMs: 3000,
    })
    openAiCreate.mockRejectedValueOnce(new FakeApiError(402, new Headers()))
    await expect(c.chatCompletion(req)).rejects.toBeInstanceOf(LlmQuotaError)
    openAiCreate.mockRejectedValueOnce(new FakeApiError(401, new Headers()))
    await expect(c.chatCompletion(req)).rejects.toBeInstanceOf(LlmAuthError)
    openAiCreate.mockRejectedValueOnce(
      new FakeApiError(400, new Headers(), { error: { message: 'maximum context length' } }),
    )
    await expect(c.chatCompletion(req)).rejects.toBeInstanceOf(LlmContextLengthError)
    openAiCreate.mockRejectedValueOnce(new FakeApiError(500, new Headers(), 'boom'))
    await expect(c.chatCompletion(req)).rejects.toBeInstanceOf(LlmServerError)
    openAiCreate.mockRejectedValueOnce(new FakeApiUserAbortError())
    await expect(c.chatCompletion(req)).rejects.toBeInstanceOf(LlmAbortError)
  })

  it('pool: 429 blocks the key, 402 disables it, then no keys left', async () => {
    const pool = new OpenRouterPoolSupplier({
      clients: [
        { apiKey: 'k1', apiUrl: 'http://p' },
        { apiKey: 'k2', apiUrl: 'http://p' },
      ],
    })
    const c = createOpenAiSdkClient({ pool })
    openAiCreate.mockRejectedValueOnce(new FakeApiError(429, new Headers()))
    await expect(c.chatCompletion(req)).rejects.toBeInstanceOf(LlmRateLimitError)
    openAiCreate.mockResolvedValueOnce(okOpenAi())
    await c.chatCompletion(req) // k2
    expect(pool.getPool().statusCounts()).toMatchObject({ rateLimited: 1, available: 1 })
    openAiCreate.mockRejectedValueOnce(new FakeApiError(402, new Headers()))
    await expect(c.chatCompletion(req)).rejects.toBeInstanceOf(LlmQuotaError)
    expect(pool.getPool().statusCounts()).toMatchObject({ disabled: 1, available: 0 })
    await expect(c.chatCompletion(req)).rejects.toBeInstanceOf(LlmRateLimitError)
  })

  it('streams: aggregates deltas, reports usage, calls onDelta', async () => {
    const c = createOpenAiSdkClient({})
    async function* chunks() {
      yield { choices: [{ delta: { content: 'Hel' } }] }
      yield { choices: [{ delta: { content: 'lo' } }] }
      yield { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 4, total_tokens: 6 } }
    }
    openAiCreate.mockResolvedValueOnce(chunks())
    const deltas: string[] = []
    const res = await c.chatCompletionStream?.(req, (d) => deltas.push(d))
    expect(res).toMatchObject({ content: 'Hello', finishReason: 'stop' })
    expect(res?.usage).toEqual({ promptTokens: 4, completionTokens: 0, totalTokens: 6 })
    expect(deltas).toEqual(['Hel', 'lo'])
    const params = openAiCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(params.stream).toBe(true)
  })

  it('cache decorator skips the SDK transport on a repeat call', async () => {
    const store = new Map<string, unknown>()
    const cache = {
      computeKey: (o: { toolName: string; version: string; input: unknown }) => JSON.stringify(o),
      get: async <T>(k: string) => store.get(k) as T | undefined,
      set: async (k: string, _o: unknown, v: unknown) => {
        store.set(k, v)
      },
    }
    const c = withCache(createOpenAiSdkClient({}), cache)
    openAiCreate.mockResolvedValueOnce(okOpenAi('once'))
    await c.chatCompletion(req)
    const second = await c.chatCompletion(req)
    expect(openAiCreate).toHaveBeenCalledTimes(1)
    expect(second).toMatchObject({ content: 'once', cached: true })
  })
})

// ---------------------------------------------------------------------------
// Anthropic SDK adapter
// ---------------------------------------------------------------------------

describe('createAnthropicSdkClient', () => {
  it('maps messages/system/json and response; streams events', async () => {
    const c = createAnthropicSdkClient({ apiKey: 'ak' })
    expect(anthropicConstructor).not.toHaveBeenCalled()
    anthropicCreate.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
      ],
      model: 'claude-x',
      stop_reason: 'end_turn',
      usage: { input_tokens: 4, output_tokens: 6 },
    })
    const res = await c.chatCompletion({
      model: 'claude-x',
      system: 'S1',
      messages: [
        { role: 'system', content: 'S2' },
        { role: 'user', content: 'u' },
      ],
      responseFormat: 'json',
    })
    expect(anthropicConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'ak', maxRetries: 0 }),
    )
    expect(res).toMatchObject({
      content: 'AB',
      finishReason: 'end_turn',
      usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
    })
    const params = anthropicCreate.mock.calls[0]?.[0] as {
      system: string
      messages: unknown[]
    }
    expect(params.system).toContain('S1')
    expect(params.system).toContain('JSON')
    expect(params.messages).toEqual([{ role: 'user', content: 'u' }])

    // streaming
    async function* events() {
      yield { type: 'message_start', message: { usage: { input_tokens: 7 } } }
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '!' } }
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      }
    }
    anthropicCreate.mockResolvedValueOnce(events())
    const deltas: string[] = []
    const streamed = await c.chatCompletionStream?.(
      { model: 'claude-x', messages: [{ role: 'user', content: 'u' }] },
      (d) => deltas.push(d),
    )
    expect(streamed).toMatchObject({
      content: 'Hi!',
      finishReason: 'end_turn',
      usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
    })
    expect(deltas).toEqual(['Hi', '!'])
  })

  it('missing key -> LlmAuthError; SDK 429 maps with retry-after', async () => {
    const noKey = createAnthropicSdkClient({})
    await expect(noKey.chatCompletion(req)).rejects.toBeInstanceOf(LlmAuthError)
    const c = createAnthropicSdkClient({ apiKey: 'ak' })
    anthropicCreate.mockRejectedValueOnce(
      new FakeApiError(429, new Headers({ 'retry-after': '9' })),
    )
    await expect(c.chatCompletion(req)).rejects.toMatchObject({ retryAfterMs: 9000 })
  })
})
