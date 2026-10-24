import type { RetryPolicy } from '@mt/core'
import { withRetry as coreWithRetry } from '@mt/core'
import type { CacheLike, LlmClient, LlmRequest, LlmResponse } from './llm-client.js'
import { LlmAbortError, LlmTimeoutError, isRetryableLlmError } from './llm-errors.js'

/**
 * Per-call timeout + AbortSignal. Works even when the inner client ignores the signal
 * (the returned promise rejects on timeout/abort regardless).
 */
export function withTimeout(inner: LlmClient, defaultTimeoutMs: number): LlmClient {
  return {
    async chatCompletion(req: LlmRequest): Promise<LlmResponse> {
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
        const call = inner.chatCompletion({ ...req, signal: controller.signal })
        // Avoid unhandled rejection if the guard wins the race.
        call.catch(() => undefined)
        return await Promise.race([call, guard])
      } finally {
        if (timer) clearTimeout(timer)
        if (outer && onAbort) outer.removeEventListener('abort', onAbort)
        guard.catch(() => undefined)
      }
    },
  }
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
  return {
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
  })
}

/** Memoise responses by stable request hash using core `Cache`-compatible storage. */
export function withCache(
  inner: LlmClient,
  cache: CacheLike,
  options: LlmCacheOptions = {},
): LlmClient {
  const toolName = `llm-chat${options.namespace ? `:${options.namespace}` : ''}`
  const version = options.version ?? '1'
  return {
    async chatCompletion(req: LlmRequest): Promise<LlmResponse> {
      if (options.when && !options.when(req)) return inner.chatCompletion(req)
      const keyOptions = { toolName, version, input: cacheableRequest(req) }
      const key = cache.computeKey(keyOptions)
      const hit = await cache.get<LlmResponse>(key)
      if (hit) return { ...hit, cached: true }
      const res = await inner.chatCompletion(req)
      await cache.set(key, keyOptions, res)
      return res
    },
  }
}
