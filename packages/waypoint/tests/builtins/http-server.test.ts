import { type Server, createServer } from 'node:http'
import type { Envelope, RunEventListener, SourceContext } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHttpSource } from '../../src/http-server.js'

/**
 * Helper: find a free port by binding to port 0, then releasing it.
 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

function makeUri(
  port: number,
  path = '/ingest',
  extraQuery: Record<string, string> = {},
): ParsedUri {
  const query = { port: String(port), ...extraQuery }
  return {
    raw: `http://localhost:${port}${path}`,
    scheme: 'http',
    host: 'localhost',
    path,
    query,
    fragment: '',
  }
}

function makeMockContext() {
  return {
    run: {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    },
  }
}

describe('http-server', () => {
  it('should return a source with lifestyle long-lived', () => {
    const source = createHttpSource(makeUri(8080))
    expect(source.lifestyle).toBe('long-lived')
    expect(source.uri).toBe('http://localhost:8080/ingest')
  })

  it('should yield an envelope when POSTing to the server', async () => {
    const port = await getFreePort()
    const ctx = makeMockContext()
    const source = createHttpSource(makeUri(port))
    const iterator = source.start(ctx as SourceContext)[Symbol.asyncIterator]()

    // Start the generator — it'll log the port then block waiting for an envelope
    const nextPromise = iterator.next()
    await vi.waitFor(
      () => {
        expect(ctx.run.logger.info).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 20 },
    )

    const serverUrl = `http://localhost:${port}`

    // POST a payload
    const postRes = await fetch(`${serverUrl}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })
    expect(postRes.ok).toBe(true)

    // Read yielded envelope
    const result = await nextPromise
    expect(result.done).toBe(false)
    expect((result.value as Envelope<unknown>).item).toEqual({ message: 'hello' })

    // Cleanup
    await iterator.return?.()
  })

  it('should yield multiple envelopes from multiple POSTs', async () => {
    const port = await getFreePort()
    const ctx = makeMockContext()
    const source = createHttpSource<{ id: number }>(makeUri(port))
    const iterator = source.start(ctx as SourceContext)[Symbol.asyncIterator]()
    const nextPromise = iterator.next()
    await vi.waitFor(
      () => {
        expect(ctx.run.logger.info).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 20 },
    )

    const serverUrl = `http://localhost:${port}`

    for (const id of [1, 2, 3]) {
      const res = await fetch(`${serverUrl}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      expect(res.ok).toBe(true)
    }

    const envelopes = []
    const first = await nextPromise
    envelopes.push(first.value)
    for (let i = 0; i < 2; i++) {
      const r = await iterator.next()
      envelopes.push(r.value)
    }

    expect(envelopes).toHaveLength(3)
    expect((envelopes[0] as Envelope<unknown>).item).toEqual({ id: 1 })
    expect((envelopes[1] as Envelope<unknown>).item).toEqual({ id: 2 })
    expect((envelopes[2] as Envelope<unknown>).item).toEqual({ id: 3 })

    await iterator.return?.()
  })

  it('should return 200 for health endpoint', async () => {
    const port = await getFreePort()
    const ctx = makeMockContext()
    const source = createHttpSource(makeUri(port))
    const iterator = source.start(ctx as SourceContext)[Symbol.asyncIterator]()

    // Fire and forget the generator — it'll log then block
    iterator.next().catch(() => {})
    await vi.waitFor(
      () => {
        expect(ctx.run.logger.info).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 20 },
    )

    const healthRes = await fetch(`http://localhost:${port}/health`)
    expect(healthRes.ok).toBe(true)
    const data = (await healthRes.json()) as Record<string, unknown>
    expect(data).toEqual({ status: 'ok' })

    // Unblock the generator by POSTing, then return it
    await fetch(`http://localhost:${port}/ingest`, { method: 'POST', body: '{}' }).catch(() => {})
    await iterator.return?.()
  })

  it('should stop cleanly when iterator returns', async () => {
    const port = await getFreePort()
    const ctx = makeMockContext()
    const source = createHttpSource(makeUri(port))
    const iterator = source.start(ctx as SourceContext)[Symbol.asyncIterator]()

    iterator.next().catch(() => {})
    await vi.waitFor(
      () => {
        expect(ctx.run.logger.info).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 20 },
    )

    // Unblock the generator by POSTing to /ingest, then return the iterator
    await fetch(`http://localhost:${port}/ingest`, { method: 'POST', body: '{"done":true}' }).catch(
      () => {},
    )
    // Wait for the next() to resolve (don't care about the value)
    await new Promise((r) => setTimeout(r, 100))

    // Now iterator.return() should work without hanging
    await iterator.return?.()

    // Verify server is stopped
    const healthRes = await fetch(`http://localhost:${port}/health`).catch(() => null)
    expect(healthRes?.ok).toBeFalsy()
  })
})

/** Accumulate an SSE stream so tests can assert on delivered frames. */
interface SseClient {
  body: string
  cancel: () => Promise<void>
}

async function connectSse(port: number): Promise<SseClient> {
  const res = await fetch(`http://localhost:${port}/events`)
  const reader = res.body?.getReader()
  const client: SseClient = {
    body: '',
    cancel: async () => {
      await reader?.cancel().catch(() => {})
    },
  }
  if (!reader) return client

  const decoder = new TextDecoder()
  const pump = async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      client.body += decoder.decode(value, { stream: true })
    }
  }
  pump().catch(() => {})
  return client
}

/** Fail the test instead of hanging forever when the source misbehaves. */
const TIMED_OUT = Symbol('timed-out')

async function mustResolve<T>(promise: Promise<T>, ms: number): Promise<T> {
  const raced = await Promise.race<T | typeof TIMED_OUT>([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => {
      setTimeout(() => resolve(TIMED_OUT), ms)
    }),
  ])
  if (raced === TIMED_OUT) {
    throw new Error(`promise did not settle within ${ms}ms`)
  }
  return raced
}

describe('http-server — /events fan-out', () => {
  it('should not steal buffered envelopes when a client subscribes to /events', async () => {
    const port = await getFreePort()
    const ctx = makeMockContext()
    const source = createHttpSource<{ id: number }>(makeUri(port))
    const iterator = source.start(ctx as SourceContext)[Symbol.asyncIterator]()

    // Park the consumer: first envelope is delivered straight to this pending next()
    const first = iterator.next()
    await vi.waitFor(
      () => {
        expect(ctx.run.logger.info).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 20 },
    )

    await fetch(`http://localhost:${port}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ id: 1 }),
    })
    expect((await first).value).toEqual({ item: { id: 1 }, meta: {} })

    // Consumer is not reading now, so these two land in the pipeline buffer
    for (const id of [2, 3]) {
      await fetch(`http://localhost:${port}/ingest`, {
        method: 'POST',
        body: JSON.stringify({ id }),
      })
    }

    const sse = await connectSse(port)
    await vi.waitFor(
      () => {
        expect(sse.body).toContain(': connected')
      },
      { timeout: 3000, interval: 20 },
    )

    // Buffering must survive the subscription — the pipeline still owns those envelopes
    const second = await mustResolve(iterator.next(), 3000)
    expect((second as { value: Envelope<unknown> }).value.item).toEqual({ id: 2 })

    const third = await mustResolve(iterator.next(), 3000)
    expect((third as { value: Envelope<unknown> }).value.item).toEqual({ id: 3 })

    await sse.cancel()
    await iterator.return?.()
  })

  it('should push live envelopes to /events subscribers', async () => {
    const port = await getFreePort()
    const ctx = makeMockContext()
    const source = createHttpSource<{ id: number }>(makeUri(port))
    const iterator = source.start(ctx as SourceContext)[Symbol.asyncIterator]()
    const first = iterator.next()
    await vi.waitFor(
      () => {
        expect(ctx.run.logger.info).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 20 },
    )

    const sse = await connectSse(port)
    await vi.waitFor(
      () => {
        expect(sse.body).toContain(': connected')
      },
      { timeout: 3000, interval: 20 },
    )

    await fetch(`http://localhost:${port}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ id: 42 }),
    })
    await vi.waitFor(
      () => {
        expect(sse.body).toContain('data: {"item":{"id":42},"meta":{}}\n\n')
      },
      { timeout: 3000, interval: 20 },
    )

    expect((await first).value).toEqual({ item: { id: 42 }, meta: {} })

    await sse.cancel()
    await iterator.return?.()
  })
})

describe('http-server — shutdown with open SSE client', () => {
  it('should finish the run within 2s while an /events client is still attached', async () => {
    const port = await getFreePort()
    const ctx = makeMockContext()
    const source = createHttpSource<{ id: number }>(makeUri(port, '/ingest', { count: '1' }))
    const iterator = source.start(ctx as SourceContext)[Symbol.asyncIterator]()

    const first = iterator.next()
    await vi.waitFor(
      () => {
        expect(ctx.run.logger.info).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 20 },
    )

    const sse = await connectSse(port)
    await vi.waitFor(
      () => {
        expect(sse.body).toContain(': connected')
      },
      { timeout: 3000, interval: 20 },
    )

    await fetch(`http://localhost:${port}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ id: 1 }),
    })
    expect((await first).done).toBe(false)

    // Resuming the generator hits the count limit and the finally block (server teardown)
    const startedAt = Date.now()
    const closed = await mustResolve(iterator.next(), 2000)
    expect(closed.done).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(2000)

    await sse.cancel()
  })
})

describe('http-server — run lifecycle mirror', () => {
  it('mirrors lifecycle run events to /events subscribers and unsubscribes on teardown', async () => {
    const port = await getFreePort()
    const listeners = new Set<RunEventListener>()
    const ctx = {
      ...makeMockContext(),
      events: {
        subscribe: (listener: RunEventListener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    }
    const source = createHttpSource<{ id: number }>(makeUri(port, '/ingest', { count: '1' }))
    const iterator = source.start(ctx as SourceContext)[Symbol.asyncIterator]()

    const first = iterator.next()
    await vi.waitFor(
      () => {
        expect(ctx.run.logger.info).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 20 },
    )
    expect(listeners.size).toBe(1)

    const sse = await connectSse(port)
    await vi.waitFor(
      () => {
        expect(sse.body).toContain(': connected')
      },
      { timeout: 3000, interval: 20 },
    )

    // Emit through the fake runner facade: lifecycle types are mirrored…
    for (const listener of listeners) {
      listener({ type: 'paused', ts: new Date().toISOString(), runId: 'fake-run' })
    }
    await vi.waitFor(
      () => {
        expect(sse.body).toContain('data: {"type":"lifecycle","event":"paused"}\n\n')
      },
      { timeout: 3000, interval: 20 },
    )

    // …but envelope-free types like step-done are not.
    for (const listener of listeners) {
      listener({ type: 'step-done', ts: new Date().toISOString(), runId: 'fake-run', stepId: 'x' })
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(sse.body).not.toContain('"event":"step-done"')

    // Finish the generator (count limit) — teardown must unsubscribe.
    await fetch(`http://localhost:${port}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ id: 1 }),
    })
    expect((await first).done).toBe(false)
    expect((await iterator.next()).done).toBe(true)
    expect(listeners.size).toBe(0)

    await sse.cancel()
  })

  it('works without an events facade in the context', async () => {
    const port = await getFreePort()
    const ctx = makeMockContext()
    const source = createHttpSource(makeUri(port, '/ingest', { count: '1' }))
    const iterator = source.start(ctx as SourceContext)[Symbol.asyncIterator]()
    iterator.next().catch(() => {})
    await vi.waitFor(
      () => {
        expect(ctx.run.logger.info).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 20 },
    )

    await fetch(`http://localhost:${port}/ingest`, { method: 'POST', body: '{}' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await iterator.return?.()

    const healthRes = await fetch(`http://localhost:${port}/health`).catch(() => null)
    expect(healthRes?.ok).toBeFalsy()
  })
})

describe('http-server — ingest limits', () => {
  it('should reject bodies above maxBodyBytes with 413', async () => {
    const port = await getFreePort()
    const ctx = makeMockContext()
    const source = createHttpSource(makeUri(port))
    const iterator = source.start(ctx as SourceContext)[Symbol.asyncIterator]()
    iterator.next().catch(() => {})
    await vi.waitFor(
      () => {
        expect(ctx.run.logger.info).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 20 },
    )

    const big = JSON.stringify({ payload: 'x'.repeat(10 * 1024 * 1024) })
    const res = await fetch(`http://localhost:${port}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: big,
    })
    expect(res.status).toBe(413)

    // Oversized body must never reach the pipeline
    const error = (await res.json()) as Record<string, unknown>
    expect(error).toEqual({ error: 'Payload too large' })

    // Unblock the parked consumer so the iterator can be returned
    await fetch(`http://localhost:${port}/ingest`, { method: 'POST', body: '{}' })
    await iterator.return?.()

    const healthRes = await fetch(`http://localhost:${port}/health`).catch(() => null)
    expect(healthRes?.ok).toBeFalsy()
  })

  it('should honour a custom maxBodyBytes', async () => {
    const port = await getFreePort()
    const ctx = makeMockContext()
    const source = createHttpSource(makeUri(port, '/ingest', { maxBodyBytes: '64' }))
    const iterator = source.start(ctx as SourceContext)[Symbol.asyncIterator]()
    iterator.next().catch(() => {})
    await vi.waitFor(
      () => {
        expect(ctx.run.logger.info).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 20 },
    )

    const tooBig = await fetch(`http://localhost:${port}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ payload: 'y'.repeat(512) }),
    })
    expect(tooBig.status).toBe(413)

    const ok = await fetch(`http://localhost:${port}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ id: 1 }),
    })
    expect(ok.status).toBe(200)

    await iterator.return?.()
  })

  it('should answer 503 with Retry-After once the buffer is full', async () => {
    const port = await getFreePort()
    const ctx = makeMockContext()
    const source = createHttpSource<{ id: number }>(makeUri(port, '/ingest', { maxBuffer: '2' }))
    const iterator = source.start(ctx as SourceContext)[Symbol.asyncIterator]()

    const first = iterator.next()
    await vi.waitFor(
      () => {
        expect(ctx.run.logger.info).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 20 },
    )
    // Drain the parked consumer so the buffer starts empty
    await fetch(`http://localhost:${port}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ id: 0 }),
    })
    await first

    for (const id of [1, 2]) {
      const res = await fetch(`http://localhost:${port}/ingest`, {
        method: 'POST',
        body: JSON.stringify({ id }),
      })
      expect(res.status).toBe(200)
    }

    const rejected = await fetch(`http://localhost:${port}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ id: 3 }),
    })
    expect(rejected.status).toBe(503)
    expect(rejected.headers.get('retry-after')).toBeTruthy()
    expect((await rejected.json()) as Record<string, unknown>).toEqual({ error: 'Buffer full' })

    // Backpressure must not corrupt what is already buffered
    const second = await iterator.next()
    const third = await iterator.next()
    expect((second.value as Envelope<unknown>).item).toEqual({ id: 1 })
    expect((third.value as Envelope<unknown>).item).toEqual({ id: 2 })

    await iterator.return?.()
  })
})
