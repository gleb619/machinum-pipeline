import { Cache } from '@mt/core'
import { describe, expect, it, vi } from 'vitest'
import type { CacheLike, LlmClient, LlmRequest, LlmResponse } from '../src/core/llm-client.js'
import { withCache, withLlmRetry, withTimeout } from '../src/core/llm-decorators.js'
import { LlmNetworkError, LlmTimeoutError } from '../src/core/llm-errors.js'

const req: LlmRequest = { model: 'm', messages: [{ role: 'user', content: 'q' }] }
const fast = { max: 2, backoffMs: 0, strategy: 'fixed' as const }

type StreamFn = (req: LlmRequest, onDelta?: (delta: string) => void) => Promise<LlmResponse>

function response(content: string): LlmResponse {
  return {
    content,
    model: 'm',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }
}

/** The optional method as a plain callable (fails loudly when a decorator dropped it). */
function streamOf(client: LlmClient): StreamFn {
  const fn = client.chatCompletionStream
  if (!fn) throw new Error('client does not expose chatCompletionStream')
  return fn.bind(client)
}

function streamingClient(streamImpl: StreamFn): LlmClient {
  return {
    chatCompletion: async () => response('nonstream'),
    chatCompletionStream: streamImpl,
  }
}

function memory(overrides: Partial<CacheLike> = {}): CacheLike {
  const store = new Map<string, unknown>()
  const core = new Cache('/nonexistent')
  return {
    computeKey: (o) => core.computeKey(o),
    get: async <T>(k: string) => store.get(k) as T | undefined,
    set: async (k, _o, v) => {
      store.set(k, v)
    },
    ...overrides,
  }
}

describe('withTimeout streaming', () => {
  it('aborts a hung stream on timeout', async () => {
    const hung = streamingClient(
      (r) =>
        new Promise((_, reject) => {
          r.signal?.addEventListener('abort', () => reject(new Error('aborted inner')))
        }),
    )
    await expect(streamOf(withTimeout(hung, 20))(req)).rejects.toBeInstanceOf(LlmTimeoutError)
  })

  it('aborts a stream on the caller signal', async () => {
    const hung = streamingClient(
      (r) =>
        new Promise((_, reject) => {
          r.signal?.addEventListener('abort', () => reject(new Error('aborted inner')))
        }),
    )
    const ac = new AbortController()
    const p = streamOf(withTimeout(hung, 10_000))({ ...req, signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'LlmAbortError' })
  })

  it('forwards deltas and the aggregated response', async () => {
    const client = withTimeout(
      streamingClient(async (_r, onDelta) => {
        onDelta?.('a')
        onDelta?.('b')
        return response('ab')
      }),
      1000,
    )
    const deltas: string[] = []
    const res = await streamOf(client)(req, (d) => deltas.push(d))
    expect(deltas).toEqual(['a', 'b'])
    expect(res.content).toBe('ab')
  })

  it('adds no streaming method when the inner client has none', () => {
    const client = withTimeout({ chatCompletion: async () => response('x') }, 1000)
    expect(client.chatCompletionStream).toBeUndefined()
  })
})

describe('withLlmRetry streaming', () => {
  it('retries a stream failure that happened before any delta', async () => {
    let calls = 0
    const inner = streamingClient(async (_r, onDelta) => {
      calls++
      if (calls === 1) throw new LlmNetworkError('boom')
      onDelta?.('ok')
      return response('ok')
    })
    const deltas: string[] = []
    const res = await streamOf(withLlmRetry(inner, fast))(req, (d) => deltas.push(d))
    expect(calls).toBe(2)
    expect(deltas).toEqual(['ok'])
    expect(res.content).toBe('ok')
  })

  it('does not retry once a delta reached the consumer (no duplicated text)', async () => {
    let calls = 0
    const inner = streamingClient(async (_r, onDelta) => {
      calls++
      onDelta?.('partial')
      throw new LlmNetworkError('dropped mid-stream')
    })
    const deltas: string[] = []
    const onRetry = vi.fn()
    await expect(
      streamOf(withLlmRetry(inner, fast, { onRetry }))(req, (d) => deltas.push(d)),
    ).rejects.toBeInstanceOf(LlmNetworkError)
    expect(calls).toBe(1)
    expect(deltas).toEqual(['partial'])
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('does not retry non-retryable errors', async () => {
    let calls = 0
    const fatal = new Error('nope')
    const inner = streamingClient(async () => {
      calls++
      throw fatal
    })
    await expect(streamOf(withLlmRetry(inner, fast))(req)).rejects.toBe(fatal)
    expect(calls).toBe(1)
  })
})

describe('withCache streaming', () => {
  it('replays a cached hit through onDelta once and skips the inner client', async () => {
    let calls = 0
    const inner = streamingClient(async (_r, onDelta) => {
      calls++
      onDelta?.('abc')
      return response('abc')
    })
    const client = withCache(inner, memory())
    const first = await streamOf(client)(req)
    expect(first.content).toBe('abc')
    const deltas: string[] = []
    const hit = await streamOf(client)(req, (d) => deltas.push(d))
    expect(calls).toBe(1)
    expect(deltas).toEqual(['abc'])
    expect(hit).toMatchObject({ content: 'abc', cached: true })
  })

  it('stores the aggregated stream response', async () => {
    const cache = memory()
    const client = withCache(
      streamingClient(async (_r, onDelta) => {
        onDelta?.('stored')
        return response('stored')
      }),
      cache,
    )
    await streamOf(client)(req)
    const replay = await streamOf(client)(req)
    expect(replay).toMatchObject({ content: 'stored', cached: true })
  })

  it('bypasses the cache when when() returns false', async () => {
    let calls = 0
    const inner = streamingClient(async () => {
      calls++
      return response('raw')
    })
    const client = withCache(inner, memory(), { when: () => false })
    await streamOf(client)(req)
    await streamOf(client)(req)
    expect(calls).toBe(2)
  })

  it('swallows a cache set failure and still returns the paid response', async () => {
    const onCacheError = vi.fn()
    const cache = memory({
      set: async () => {
        throw new Error('disk full')
      },
    })
    const client = withCache(
      streamingClient(async (_r, onDelta) => {
        onDelta?.('paid')
        return response('paid')
      }),
      cache,
      { onCacheError },
    )
    const res = await streamOf(client)(req)
    expect(res.content).toBe('paid')
    expect(onCacheError).toHaveBeenCalledTimes(1)
  })

  it('treats a cache get failure as a miss', async () => {
    const onCacheError = vi.fn()
    const cache = memory({
      get: async () => {
        throw new Error('unreadable')
      },
    })
    let calls = 0
    const client = withCache(
      streamingClient(async () => {
        calls++
        return response('fresh')
      }),
      cache,
      { onCacheError },
    )
    expect((await streamOf(client)(req)).content).toBe('fresh')
    expect(calls).toBe(1)
    expect(onCacheError).toHaveBeenCalledTimes(1)
  })
})

describe('withCache failure isolation (buffered call)', () => {
  it('returns the response when set rejects', async () => {
    const onCacheError = vi.fn()
    const client = withCache(
      { chatCompletion: async () => response('paid') },
      memory({
        set: async () => {
          throw new Error('disk full')
        },
      }),
      { onCacheError },
    )
    expect((await client.chatCompletion(req)).content).toBe('paid')
    expect(onCacheError).toHaveBeenCalledWith(expect.any(Error), 'set', req)
  })

  it('falls back to the inner call when get rejects', async () => {
    const onCacheError = vi.fn()
    const client = withCache(
      { chatCompletion: async () => response('fresh') },
      memory({
        get: async () => {
          throw new Error('unreadable')
        },
      }),
      { onCacheError },
    )
    expect((await client.chatCompletion(req)).content).toBe('fresh')
    expect(onCacheError).toHaveBeenCalledWith(expect.any(Error), 'get', req)
  })
})
