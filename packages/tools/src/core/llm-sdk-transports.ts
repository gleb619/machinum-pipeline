/**
 * Official-SDK-backed LLM adapters (`openai`, `@anthropic-ai/sdk`).
 *
 * Both SDKs are loaded lazily via dynamic `import()` on the first call, so users
 * who never touch a provider never pay for its SDK. Only a minimal structural
 * slice of each SDK surface is described here (typed local interfaces); the
 * modules are cast to them at load time.
 *
 * Error mapping reuses `classifyHttpError` so SDK failures produce the exact
 * same typed errors (`LlmRateLimitError` with retry-after, `LlmQuotaError` for
 * 402, `LlmAuthError`, `LlmContextLengthError` on context-length 400s,
 * `LlmServerError` for 5xx, `LlmAbortError`, `LlmTimeoutError`,
 * `LlmNetworkError`) as the fetch adapters, including the OpenRouter pool
 * 429-block / 402-disable behaviour.
 */
import { createRequire } from 'node:module'
import type { LlmClient, LlmMessage, LlmRequest, LlmResponse } from './llm-client.js'
import type { LlmProvider, ResolvedLlmConfig } from './llm-config.js'
import { DEFAULT_TIMEOUT_MS } from './llm-config.js'
import {
  LlmAbortError,
  LlmAuthError,
  LlmError,
  LlmNetworkError,
  LlmRateLimitError,
  LlmTimeoutError,
  classifyHttpError,
} from './llm-errors.js'
import {
  type OpenRouterClient,
  type OpenRouterPoolSupplier,
  applyPoolError,
  sharedPoolFor,
} from './openrouter-pool.js'

// ---------------------------------------------------------------------------
// Minimal structural SDK interfaces (typed locals; the real SDKs are cast to these)
// ---------------------------------------------------------------------------

interface SdkHeaderLike {
  get?(name: string): string | null
  forEach?(fn: (value: string, name: string) => void): void
}

interface SdkErrorLike {
  name?: string
  message?: string
  status?: number
  headers?: SdkHeaderLike | Record<string, string>
  error?: unknown
}

interface OpenAiClientLike {
  chat: {
    completions: {
      create(
        params: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): Promise<unknown> | AsyncIterable<unknown>
    }
  }
}

interface AnthropicClientLike {
  messages: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<unknown> | AsyncIterable<unknown>
  }
}

interface OpenAiSdkModule {
  default: new (options: {
    apiKey?: string
    baseURL?: string
    timeout?: number
    maxRetries?: number
  }) => OpenAiClientLike
}

interface AnthropicSdkModule {
  default: new (options: {
    apiKey?: string
    baseURL?: string
    timeout?: number
    maxRetries?: number
  }) => AnthropicClientLike
}

// ---------------------------------------------------------------------------
// Lazy loading + availability
// ---------------------------------------------------------------------------

type SdkPackage = 'openai' | '@anthropic-ai/sdk'

const require = createRequire(import.meta.url)
const availabilityCache = new Map<SdkPackage, boolean>()

/** True when the SDK package can be resolved from this package (result cached). */
export function isSdkPackageAvailable(pkg: SdkPackage): boolean {
  const cached = availabilityCache.get(pkg)
  if (cached !== undefined) return cached
  let ok = false
  try {
    require.resolve(pkg)
    ok = true
  } catch {
    ok = false
  }
  availabilityCache.set(pkg, ok)
  return ok
}

/** Test hook: pin/clear the availability cache. */
export function setSdkPackageAvailableForTests(
  pkg: SdkPackage,
  available: boolean | undefined,
): void {
  if (available === undefined) availabilityCache.delete(pkg)
  else availabilityCache.set(pkg, available)
}

async function loadOpenAiSdk(): Promise<OpenAiSdkModule> {
  return (await import('openai')) as unknown as OpenAiSdkModule
}

async function loadAnthropicSdk(): Promise<AnthropicSdkModule> {
  return (await import('@anthropic-ai/sdk')) as unknown as AnthropicSdkModule
}

/** Default transport per provider: SDK when the package is resolvable, else fetch. */
export function defaultTransportKind(
  provider: LlmProvider,
  available: (pkg: SdkPackage) => boolean = isSdkPackageAvailable,
): 'sdk' | 'fetch' {
  if (provider === 'router') return 'fetch' // router proxy stays on the fetch adapter
  const pkg: SdkPackage = provider === 'anthropic' ? '@anthropic-ai/sdk' : 'openai'
  return available(pkg) ? 'sdk' : 'fetch'
}

/** Build an SDK-backed client for a resolved config, or undefined to fall back to fetch. */
export function createSdkAdapter(cfg: ResolvedLlmConfig): LlmClient | undefined {
  switch (cfg.provider) {
    case 'router':
      return undefined
    case 'anthropic':
      if (!isSdkPackageAvailable('@anthropic-ai/sdk')) return undefined
      if (!cfg.apiKey) {
        // Keep the fetch adapter's clear error by letting it handle the missing key.
        return undefined
      }
      return createAnthropicSdkClient({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        timeoutMs: cfg.timeoutMs,
      })
    default: {
      if (!isSdkPackageAvailable('openai')) return undefined
      const pool =
        cfg.provider === 'openrouter' && cfg.apiKeys.length > 0
          ? sharedPoolFor(cfg.apiKeys, cfg.baseUrl)
          : undefined
      return createOpenAiSdkClient({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        timeoutMs: cfg.timeoutMs,
        pool,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Shared error mapping
// ---------------------------------------------------------------------------

function headersToRecord(headers: SdkErrorLike['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  const h = headers as SdkHeaderLike
  if (typeof h.forEach === 'function') {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v
    })
    return out
  }
  if (typeof h.get === 'function') {
    const ra = h.get('retry-after')
    if (ra) out['retry-after'] = ra
    return out
  }
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = String(v)
  return out
}

function errorBodyToString(err: SdkErrorLike): string {
  if (err.error !== undefined && err.error !== null) {
    try {
      return JSON.stringify(err.error)
    } catch {
      // fall through to message
    }
  }
  return err.message ?? String(err)
}

/** Map an SDK-thrown error onto the shared typed error hierarchy. */
export function mapSdkError(err: unknown, timeoutMs: number): LlmError {
  if (err instanceof LlmError) return err
  const e = err as SdkErrorLike
  const name = (err instanceof Error && err.name) || e.name || ''
  if (name === 'APIUserAbortError') {
    return new LlmAbortError('LLM call aborted', { cause: err })
  }
  if (typeof e.status === 'number') {
    // Reuses 429 retry-after / 402 / 401-403 / context-length 400 / 5xx mapping.
    return classifyHttpError(e.status, errorBodyToString(e), headersToRecord(e.headers))
  }
  if (name === 'APIConnectionTimeoutError') {
    return new LlmTimeoutError(timeoutMs, { cause: err })
  }
  if (name === 'APIConnectionError' || name === 'RetryableError') {
    return new LlmNetworkError(
      `LLM network error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  if (err instanceof Error) {
    return new LlmNetworkError(`LLM network error: ${err.message}`, { cause: err })
  }
  return new LlmNetworkError(`LLM network error: ${String(err)}`, { cause: err })
}

// ---------------------------------------------------------------------------
// OpenAI SDK adapter (also covers OpenRouter / Ollama / OpenAI-compatible)
// ---------------------------------------------------------------------------

export interface OpenAiSdkClientOptions {
  apiKey?: string
  baseUrl?: string
  timeoutMs?: number
  /** Key pool (OpenRouter): picks a key per call, handles 429 / 402. */
  pool?: OpenRouterPoolSupplier
}

interface OpenAiChoiceMessage {
  message?: { content?: string | null }
  finish_reason?: string
}

interface OpenAiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function createOpenAiSdkClient(options: OpenAiSdkClientOptions): LlmClient {
  let clientPromise: Promise<OpenAiClientLike> | undefined
  const client = (): Promise<OpenAiClientLike> => {
    if (!clientPromise) {
      clientPromise = loadOpenAiSdk().then(
        (mod) =>
          new mod.default({
            ...(options.apiKey ? { apiKey: options.apiKey } : {}),
            ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxRetries: 0, // retries live in withLlmRetry so the pool rotates per attempt
          }),
      )
    }
    return clientPromise
  }

  const buildParams = (req: LlmRequest): Record<string, unknown> => {
    const messages: LlmMessage[] = []
    if (req.system) messages.push({ role: 'system', content: req.system })
    messages.push(...req.messages)
    const params: Record<string, unknown> = { model: req.model, messages }
    if (req.temperature !== undefined) params.temperature = req.temperature
    if (req.maxTokens !== undefined) params.max_tokens = req.maxTokens
    if (req.responseFormat === 'json') params.response_format = { type: 'json_object' }
    return params
  }

  const mapResponse = (data: unknown, req: LlmRequest): LlmResponse => {
    const d = data as {
      choices?: OpenAiChoiceMessage[]
      model?: string
      usage?: OpenAiUsage
    }
    const choice = d.choices?.[0]
    const usage = d.usage ?? {}
    return {
      content: choice?.message?.content ?? '',
      model: d.model ?? req.model,
      usage: {
        promptTokens: num(usage.prompt_tokens),
        completionTokens: num(usage.completion_tokens),
        totalTokens: num(usage.total_tokens),
      },
      finishReason: choice?.finish_reason,
    }
  }

  const pickPoolClient = (
    model: string,
  ): { picked?: OpenRouterClient; apiKey?: string; baseUrl?: string } => {
    const pool = options.pool
    if (!pool) return {}
    const picked = pool.getPool().getAvailableClient(model)
    if (!picked) {
      throw new LlmRateLimitError('No available API keys in pool (all rate-limited or disabled)', {
        retryAfterMs: 1000,
      })
    }
    return { picked, apiKey: picked.apiKey, baseUrl: picked.apiUrl }
  }

  return {
    async chatCompletion(req) {
      const timeoutMs = req.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      let picked: OpenRouterClient | undefined
      try {
        const pooled = pickPoolClient(req.model)
        picked = pooled.picked
        const data = await (await client()).chat.completions.create(buildParams(req), {
          signal: req.signal,
        })
        return mapResponse(data, req)
      } catch (err) {
        const mapped = mapSdkError(err, timeoutMs)
        applyPoolError(options.pool, picked, mapped)
        throw mapped
      }
    },

    async chatCompletionStream(req, onDelta) {
      const timeoutMs = req.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      let picked: OpenRouterClient | undefined
      try {
        const pooled = pickPoolClient(req.model)
        picked = pooled.picked
        const params = buildParams(req)
        params.stream = true
        params.stream_options = { include_usage: true }
        const stream = (await (
          await client()
        ).chat.completions.create(params, {
          signal: req.signal,
        })) as AsyncIterable<unknown>
        let content = ''
        let finishReason: string | undefined
        let usage: OpenAiUsage | undefined
        for await (const raw of stream) {
          const chunk = raw as {
            choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>
            usage?: OpenAiUsage
          }
          const delta = chunk.choices?.[0]?.delta?.content
          if (delta) {
            content += delta
            onDelta?.(delta)
          }
          const fr = chunk.choices?.[0]?.finish_reason
          if (fr) finishReason = fr
          if (chunk.usage) usage = chunk.usage
        }
        return {
          content,
          model: req.model,
          usage: {
            promptTokens: num(usage?.prompt_tokens),
            completionTokens: num(usage?.completion_tokens),
            totalTokens: num(usage?.total_tokens),
          },
          finishReason,
        }
      } catch (err) {
        const mapped = mapSdkError(err, timeoutMs)
        applyPoolError(options.pool, picked, mapped)
        throw mapped
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Anthropic SDK adapter
// ---------------------------------------------------------------------------

export interface AnthropicSdkClientOptions {
  apiKey?: string
  baseUrl?: string
  timeoutMs?: number
  /** Used when the request has none. */
  defaultMaxTokens?: number
}

interface AnthropicBlock {
  type?: string
  text?: string
}

export function createAnthropicSdkClient(options: AnthropicSdkClientOptions): LlmClient {
  let clientPromise: Promise<AnthropicClientLike> | undefined
  const client = (): Promise<AnthropicClientLike> => {
    if (!clientPromise) {
      clientPromise = loadAnthropicSdk().then(
        (mod) =>
          new mod.default({
            apiKey: options.apiKey ?? '',
            ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxRetries: 0,
          }),
      )
    }
    return clientPromise
  }

  const buildParams = (req: LlmRequest): Record<string, unknown> => {
    const systemParts: string[] = []
    if (req.system) systemParts.push(req.system)
    const messages: Array<{ role: string; content: string }> = []
    for (const m of req.messages) {
      if (m.role === 'system') systemParts.push(m.content)
      else messages.push({ role: m.role, content: m.content })
    }
    if (req.responseFormat === 'json') {
      systemParts.push('Respond with a single valid JSON value only, no prose, no code fences.')
    }
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? options.defaultMaxTokens ?? 4096,
      messages,
    }
    if (systemParts.length > 0) params.system = systemParts.join('\n\n')
    if (req.temperature !== undefined) params.temperature = req.temperature
    return params
  }

  const mapResponse = (data: unknown, req: LlmRequest): LlmResponse => {
    const d = data as {
      content?: AnthropicBlock[]
      model?: string
      stop_reason?: string
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    const prompt = num(d.usage?.input_tokens)
    const completion = num(d.usage?.output_tokens)
    return {
      content: (d.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join(''),
      model: d.model ?? req.model,
      usage: {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
      },
      finishReason: d.stop_reason,
    }
  }

  if (!options.apiKey) {
    // Match the fetch adapter's clear up-front error.
    return {
      async chatCompletion() {
        throw new LlmAuthError('Anthropic API key missing (set ANTHROPIC_API_KEY or llm.apiKey)')
      },
    }
  }

  return {
    async chatCompletion(req) {
      const timeoutMs = req.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      try {
        const data = await (await client()).messages.create(buildParams(req), {
          signal: req.signal,
        })
        return mapResponse(data, req)
      } catch (err) {
        throw mapSdkError(err, timeoutMs)
      }
    },

    async chatCompletionStream(req, onDelta) {
      const timeoutMs = req.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      try {
        const params = buildParams(req)
        params.stream = true
        const stream = (await (
          await client()
        ).messages.create(params, {
          signal: req.signal,
        })) as AsyncIterable<unknown>
        let content = ''
        let finishReason: string | undefined
        let inputTokens = 0
        let outputTokens = 0
        for await (const raw of stream) {
          const event = raw as {
            type?: string
            delta?: { type?: string; text?: string; stop_reason?: string }
            message?: { usage?: { input_tokens?: number } }
            usage?: { output_tokens?: number }
          }
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const delta = event.delta.text ?? ''
            content += delta
            onDelta?.(delta)
          } else if (event.type === 'message_start') {
            inputTokens = num(event.message?.usage?.input_tokens)
          } else if (event.type === 'message_delta') {
            outputTokens = num(event.usage?.output_tokens)
            if (event.delta?.stop_reason) finishReason = event.delta.stop_reason
          }
        }
        return {
          content,
          model: req.model,
          usage: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens: inputTokens + outputTokens,
          },
          finishReason,
        }
      } catch (err) {
        throw mapSdkError(err, timeoutMs)
      }
    },
  }
}
