import type { ToolContext } from '@mt/core'
import { Cache } from '@mt/core'
import { type ResolvedLlmConfig, readCtx } from './llm-config.js'
import { withCache, withLlmRetry, withTimeout } from './llm-decorators.js'
import {
  LlmAbortError,
  LlmAuthError,
  LlmError,
  LlmNetworkError,
  LlmRateLimitError,
  classifyHttpError,
} from './llm-errors.js'
import { createSdkAdapter } from './llm-sdk-transports.js'
import {
  type OpenRouterClient,
  type OpenRouterPoolSupplier,
  applyPoolError,
  sharedPoolFor,
} from './openrouter-pool.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type LlmResponseFormat = 'text' | 'json'

export interface LlmRequest {
  messages: LlmMessage[]
  model: string
  /** Optional system prompt (adapters prepend / map it). */
  system?: string
  temperature?: number
  maxTokens?: number
  /** `'json'` asks the provider for JSON output where supported. */
  responseFormat?: LlmResponseFormat
  /** Abort signal; never part of the cache key. */
  signal?: AbortSignal
  /** Per-call timeout override; never part of the cache key. */
  timeoutMs?: number
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Provider-reported cost in USD when available. */
  costUsd?: number
}

export interface LlmResponse {
  content: string
  model: string
  usage: LlmUsage
  finishReason?: string
  /** True when served by the cache decorator. */
  cached?: boolean
}

export interface LlmClient {
  chatCompletion(req: LlmRequest): Promise<LlmResponse>
  /**
   * Optional streaming variant: resolves to the same aggregated `LlmResponse`,
   * invoking `onDelta` with each content delta. Implemented by the SDK transports.
   */
  chatCompletionStream?(req: LlmRequest, onDelta?: (delta: string) => void): Promise<LlmResponse>
}

// ---------------------------------------------------------------------------
// Transport (injectable; default = fetch)
// ---------------------------------------------------------------------------

export interface LlmHttpRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

export interface LlmHttpResponse {
  status: number
  body: string
  headers?: Record<string, string>
}

export type LlmTransport = (req: LlmHttpRequest) => Promise<LlmHttpResponse>

export const fetchTransport: LlmTransport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: req.signal,
  })
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v
  })
  return { status: res.status, body: await res.text(), headers }
}

async function send(transport: LlmTransport, req: LlmHttpRequest): Promise<LlmHttpResponse> {
  try {
    return await transport(req)
  } catch (err) {
    if (err instanceof LlmError) throw err
    if (req.signal?.aborted) throw new LlmAbortError('LLM call aborted', { cause: err })
    const msg = err instanceof Error ? err.message : String(err)
    throw new LlmNetworkError(`LLM network error: ${msg}`, { cause: err })
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter (OpenAI, OpenRouter, Ollama, router proxy, custom)
// ---------------------------------------------------------------------------

export interface OpenAiCompatOptions {
  baseUrl: string
  /** Path appended to baseUrl. Default `/chat/completions`. */
  chatPath?: string
  apiKey?: string
  /** Key pool (OpenRouter): picks a key per call, handles 429 / 402. Overrides apiKey/baseUrl. */
  pool?: OpenRouterPoolSupplier
  headers?: Record<string, string>
  transport?: LlmTransport
}

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>
  model?: string
  usage?: {
    total_tokens?: number
    prompt_tokens?: number
    completion_tokens?: number
    cost?: number
  }
}

export class OpenAiCompatClient implements LlmClient {
  private readonly transport: LlmTransport

  constructor(private readonly options: OpenAiCompatOptions) {
    this.transport = options.transport ?? fetchTransport
  }

  async chatCompletion(req: LlmRequest): Promise<LlmResponse> {
    const { pool } = this.options
    let picked: OpenRouterClient | undefined
    let baseUrl = this.options.baseUrl
    let apiKey = this.options.apiKey
    if (pool) {
      picked = pool.getPool().getAvailableClient(req.model)
      if (!picked) {
        throw new LlmRateLimitError(
          'No available API keys in pool (all rate-limited or disabled)',
          {
            retryAfterMs: 1000,
          },
        )
      }
      apiKey = picked.apiKey
      baseUrl = picked.apiUrl
    }

    const messages: LlmMessage[] = []
    if (req.system) messages.push({ role: 'system', content: req.system })
    messages.push(...req.messages)

    const body: Record<string, unknown> = { model: req.model, messages }
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
    if (req.responseFormat === 'json') body.response_format = { type: 'json_object' }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.options.headers,
    }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    const res = await send(this.transport, {
      url: joinUrl(baseUrl, this.options.chatPath ?? '/chat/completions'),
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (res.status < 200 || res.status >= 300) {
      const err = classifyHttpError(res.status, res.body, res.headers)
      applyPoolError(pool, picked, err)
      throw err
    }

    let data: OpenAiChatResponse
    try {
      data = JSON.parse(res.body) as OpenAiChatResponse
    } catch (cause) {
      throw new LlmError('LLM returned a non-JSON response body', { cause, retryable: false })
    }
    const choice = data.choices?.[0]
    const usage = data.usage ?? {}
    return {
      content: choice?.message?.content ?? '',
      model: data.model ?? req.model,
      usage: {
        promptTokens: num(usage.prompt_tokens),
        completionTokens: num(usage.completion_tokens),
        totalTokens: num(usage.total_tokens),
        ...(typeof usage.cost === 'number' ? { costUsd: usage.cost } : {}),
      },
      finishReason: choice?.finish_reason,
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic adapter
// ---------------------------------------------------------------------------

export interface AnthropicOptions {
  baseUrl?: string
  apiKey?: string
  version?: string
  /** Anthropic requires max_tokens; used when the request has none. */
  defaultMaxTokens?: number
  headers?: Record<string, string>
  transport?: LlmTransport
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>
  model?: string
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

export class AnthropicClient implements LlmClient {
  private readonly transport: LlmTransport

  constructor(private readonly options: AnthropicOptions) {
    this.transport = options.transport ?? fetchTransport
  }

  async chatCompletion(req: LlmRequest): Promise<LlmResponse> {
    if (!this.options.apiKey) {
      throw new LlmAuthError('Anthropic API key missing (set ANTHROPIC_API_KEY or llm.apiKey)')
    }
    const systemParts: string[] = []
    if (req.system) systemParts.push(req.system)
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (const m of req.messages) {
      if (m.role === 'system') systemParts.push(m.content)
      else messages.push({ role: m.role, content: m.content })
    }
    if (req.responseFormat === 'json') {
      systemParts.push('Respond with a single valid JSON value only, no prose, no code fences.')
    }
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? this.options.defaultMaxTokens ?? 4096,
      messages,
    }
    if (systemParts.length > 0) body.system = systemParts.join('\n\n')
    if (req.temperature !== undefined) body.temperature = req.temperature

    const res = await send(this.transport, {
      url: joinUrl(this.options.baseUrl ?? 'https://api.anthropic.com', '/v1/messages'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.options.apiKey,
        'anthropic-version': this.options.version ?? '2023-06-01',
        ...this.options.headers,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    })
    if (res.status < 200 || res.status >= 300) {
      throw classifyHttpError(res.status, res.body, res.headers)
    }
    let data: AnthropicResponse
    try {
      data = JSON.parse(res.body) as AnthropicResponse
    } catch (cause) {
      throw new LlmError('LLM returned a non-JSON response body', { cause })
    }
    const prompt = num(data.usage?.input_tokens)
    const completion = num(data.usage?.output_tokens)
    return {
      content: (data.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join(''),
      model: data.model ?? req.model,
      usage: {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
      },
      finishReason: data.stop_reason,
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CacheLike {
  computeKey(options: { toolName: string; version: string; input: unknown }): string
  get<T>(key: string): Promise<T | undefined>
  set<T>(
    key: string,
    options: { toolName: string; version: string; input: unknown },
    value: T,
  ): Promise<void>
}

export interface CreateLlmClientDeps {
  /** Replace HTTP (tests / custom HTTP stacks). */
  transport?: LlmTransport
  /** Replace the cache (default: core `Cache` under `<project root>/.mt`). */
  cache?: CacheLike
  /** Skip retry/timeout/cache decorators and return the bare adapter. */
  bare?: boolean
}

/** Build the bare provider adapter for a resolved config. */
export function createAdapter(cfg: ResolvedLlmConfig, transport?: LlmTransport): LlmClient {
  switch (cfg.provider) {
    case 'anthropic':
      return new AnthropicClient({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        headers: cfg.headers,
        transport,
      })
    case 'router':
      return new OpenAiCompatClient({
        baseUrl: cfg.baseUrl,
        chatPath: '/api/chat/completions',
        headers: cfg.headers,
        transport,
      })
    case 'openrouter': {
      const keys = cfg.apiKeys.length > 0 ? cfg.apiKeys : cfg.apiKey ? [cfg.apiKey] : []
      return new OpenAiCompatClient({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        headers: cfg.headers,
        pool: keys.length > 0 ? sharedPoolFor(keys, cfg.baseUrl) : undefined,
        transport,
      })
    }
    default:
      return new OpenAiCompatClient({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        headers: cfg.headers,
        transport,
      })
  }
}

/**
 * Wire adapter -> timeout -> retry -> cache from a resolved config.
 * Retry policy comes from `cfg.retry` (already merged with ctx `defaults.retry`).
 */
export function createLlmClient(
  cfg: ResolvedLlmConfig,
  ctx?: ToolContext,
  deps: CreateLlmClientDeps = {},
): LlmClient {
  let client: LlmClient
  if (deps.transport) {
    client = createAdapter(cfg, deps.transport)
  } else if (cfg.transport === 'sdk') {
    client = createSdkAdapter(cfg) ?? createAdapter(cfg)
  } else {
    client = createAdapter(cfg)
  }
  if (deps.bare) return client
  client = withTimeout(client, cfg.timeoutMs)
  client = withLlmRetry(client, cfg.retry, {
    onRetry: (err, attempt, req) => {
      const msg = err instanceof Error ? err.message : String(err)
      readCtx(ctx).logger?.warn(`[llm] retry ${attempt + 1} model=${req.model}: ${msg}`)
    },
  })
  if (cfg.cache) {
    const cache = deps.cache ?? new Cache(`${readCtx(ctx).projectRoot}/.mt`)
    client = withCache(client, cache, { namespace: cfg.provider })
  }
  return client
}
