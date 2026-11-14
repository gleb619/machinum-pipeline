import type { RetryPolicy } from '@mt/core'
import { withRetry as coreWithRetry } from '@mt/core'
import type { CacheLike, LlmClient, LlmRequest, LlmResponse } from './llm-client.js'
import { LlmAbortError, LlmTimeoutError, isRetryableLlmError } from './llm-errors.js'

/**
 * Run one call under a per-call timeout + AbortSignal. Works even when the inner client ignores
 * the signal (the returned promise rejects on timeout/abort regardless).
 */
async function guarded<T>(
  req: LlmRequest,
  defaultTimeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = req.timeoutMs ?? defaultTimeoutMs
  const outer = req.signal
  if (outer?.aborted) throw new LlmAbortError()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined

  const guard = new Promise<never>((_, reject) => {
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const err = new LlmTimeoutError(timeoutMs)
        reject(err) // settle the race first; aborting may make the inner call reject too
        controller.abort(err)
      }, timeoutMs)
    }
    if (outer) {
      onAbort = () => {
        const err = new LlmAbortError()
        reject(err)
        controller.abort(err)
      }
      outer.addEventListener('abort', onAbort, { once: true })
    }
  })

  try {
    const running = call(controller.signal)
    // Avoid unhandled rejection if the guard wins the race.
    running.catch(() => undefined)
    return await Promise.race([running, guard])
  } finally {
    if (timer) clearTimeout(timer)
    if (outer && onAbort) outer.removeEventListener('abort', onAbort)
    guard.catch(() => undefined)
  }
}

/**
 * Per-call timeout + AbortSignal for both the buffered and the streaming call. The streaming
 * method is only attached when the inner client has it, so `llmCall`'s feature check stays honest.
 */
export function withTimeout(inner: LlmClient, defaultTimeoutMs: number): LlmClient {
  const client: LlmClient = {
    chatCompletion(req: LlmRequest): Promise<LlmResponse> {
      return guarded(req, defaultTimeoutMs, (signal) => inner.chatCompletion({ ...req, signal }))
    },
  }
  const stream = inner.chatCompletionStream
  if (stream) {
    client.chatCompletionStream = (req, onDelta) =>
      guarded(req, defaultTimeoutMs, (signal) => stream.call(inner, { ...req, signal }, onDelta))
  }
  return client
}

export interface LlmRetryOptions {
  onRetry?: (error: unknown, attempt: number, req: LlmRequest) => void
  /** Override which errors are retried. Default: `LlmError.retryable` (429, 5xx, network, timeout). */
  shouldRetry?: (error: unknown) => boolean
}

/**
 * Retry decorator built on core `withRetry` (same backoff strategies as engine retries).
 * Only retryable errors are retried; others surface immediately.
 */
export function withLlmRetry(
  inner: LlmClient,
  policy: RetryPolicy,
  options: LlmRetryOptions = {},
): LlmClient {
  const shouldRetry = options.shouldRetry ?? isRetryableLlmError
  type Outcome = { ok: LlmResponse } | { fatal: unknown }
  const client: LlmClient = {
    async chatCompletion(req: LlmRequest): Promise<LlmResponse> {
      const outcome = await coreWithRetry<Outcome>(
        async () => {
          try {
            return { ok: await inner.chatCompletion(req) }
          } catch (err) {
            if (!shouldRetry(err)) return { fatal: err }
            throw err
          }
        },
        policy,
        (err, attempt) => options.onRetry?.(err, attempt, req),
      )
      if ('fatal' in outcome) throw outcome.fatal
      return outcome.ok
    },
  }
  const stream = inner.chatCompletionStream
  if (stream) {
    client.chatCompletionStream = async (req, onDelta) => {
      // Once a delta reached the consumer the text is already out: a retry would emit it a
      // second time, so a mid-stream failure surfaces instead of restarting the call.
      let emitted = false
      const outcome = await coreWithRetry<Outcome>(
        async () => {
          try {
            return {
              ok: await stream.call(inner, req, (delta) => {
                emitted = true
                onDelta?.(delta)
              }),
            }
          } catch (err) {
            if (emitted || !shouldRetry(err)) return { fatal: err }
            throw err
          }
        },
        policy,
        (err, attempt) => options.onRetry?.(err, attempt, req),
      )
      if ('fatal' in outcome) throw outcome.fatal
      return outcome.ok
    }
  }
  return client
}

/** Alias matching the design doc name. */
export { withLlmRetry as withRetry }

export interface LlmCacheOptions {
  /** Cache key namespace (e.g. provider). */
  namespace?: string
  /** Bump to invalidate old entries. */
  version?: string
  /** Skip caching for some requests. Default: cache all. */
  when?: (req: LlmRequest) => boolean
  /**
   * Called when the cache backend fails. The cache is best-effort: a broken cache must never
   * discard a paid response, so failures degrade to a miss / a skipped write.
   */
  onCacheError?: (error: unknown, op: 'get' | 'set', req: LlmRequest) => void
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k]
      if (v !== undefined) out[k] = sortKeys(v)
    }
    return out
  }
  return value
}

/** Stable, transport-independent cache payload (no signal / timeout, sorted keys). */
export function cacheableRequest(req: LlmRequest): unknown {
  return sortKeys({
    model: req.model,
    system: req.system,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: req.temperature,
    maxTokens: req.maxTokens,
    responseFormat: req.responseFormat,
    reasoningEffort: req.reasoningEffort,
  })
}

/**
 * A reply is cacheable only when it is a complete answer: an empty `content` (thinking model
 * without `reasoning_effort`) or a reply cut off at `maxTokens` must never be served again.
 */
function isCacheableResponse(res: LlmResponse): boolean {
  return res.content.trim() !== '' && res.finishReason !== 'length'
}

interface CacheKeyOptions {
  toolName: string
  version: string
  input: unknown
}

/** Memoise responses by stable request hash using core `Cache`-compatible storage. */
export function withCache(
  inner: LlmClient,
  cache: CacheLike,
  options: LlmCacheOptions = {},
): LlmClient {
  const toolName = `llm-chat${options.namespace ? `:${options.namespace}` : ''}`
  // v2: reasoningEffort is part of the key and failed replies are not stored; v1 entries are
  // unaddressable by design, so abandon them. Streaming shares the same key: the aggregated
  // response is transport-independent, so a stream can be served from (and stored into) the
  // same entry as a buffered call.
  const version = options.version ?? '2'

  const keyOptionsFor = (req: LlmRequest): CacheKeyOptions => ({
    toolName,
    version,
    input: cacheableRequest(req),
  })

  const read = async (key: string, req: LlmRequest): Promise<LlmResponse | undefined> => {
    try {
      return await cache.get<LlmResponse>(key)
    } catch (err) {
      options.onCacheError?.(err, 'get', req)
      return undefined
    }
  }

  const write = async (
    key: string,
    keyOptions: CacheKeyOptions,
    req: LlmRequest,
    res: LlmResponse,
  ): Promise<void> => {
    if (!isCacheableResponse(res)) return
    try {
      await cache.set(key, keyOptions, res)
    } catch (err) {
      options.onCacheError?.(err, 'set', req)
    }
  }

  const client: LlmClient = {
    async chatCompletion(req: LlmRequest): Promise<LlmResponse> {
      if (options.when && !options.when(req)) return inner.chatCompletion(req)
      const keyOptions = keyOptionsFor(req)
      const key = cache.computeKey(keyOptions)
      const hit = await read(key, req)
      if (hit) return { ...hit, cached: true }
      const res = await inner.chatCompletion(req)
      await write(key, keyOptions, req, res)
      return res
    },
  }
  const stream = inner.chatCompletionStream
  if (stream) {
    client.chatCompletionStream = async (req, onDelta) => {
      if (options.when && !options.when(req)) return stream.call(inner, req, onDelta)
      const keyOptions = keyOptionsFor(req)
      const key = cache.computeKey(keyOptions)
      const hit = await read(key, req)
      if (hit) {
        // A hit has no live stream: replay the stored answer as one delta.
        if (hit.content) onDelta?.(hit.content)
        return { ...hit, cached: true }
      }
      const res = await stream.call(inner, req, onDelta)
      await write(key, keyOptions, req, res)
      return res
    }
  }
  return client
}
