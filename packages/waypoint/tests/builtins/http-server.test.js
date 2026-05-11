import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createHttpSource } from '../../src/builtins/http-server.js'
/**
 * Helper: find a free port by binding to port 0, then releasing it.
 */
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}
function makeUri(port, path = '/ingest') {
  return {
    raw: `http://localhost:${port}${path}`,
    scheme: 'http',
    host: 'localhost',
    path,
    query: { port: String(port) },
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
    const iterator = source.start(ctx)[Symbol.asyncIterator]()
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
    expect(result.value.item).toEqual({ message: 'hello' })
    // Cleanup
    await iterator.return()
  })
  it('should yield multiple envelopes from multiple POSTs', async () => {
    const port = await getFreePort()
    const ctx = makeMockContext()
    const source = createHttpSource(makeUri(port))
    const iterator = source.start(ctx)[Symbol.asyncIterator]()
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
    expect(envelopes[0].item).toEqual({ id: 1 })
    expect(envelopes[1].item).toEqual({ id: 2 })
    expect(envelopes[2].item).toEqual({ id: 3 })
    await iterator.return()
  })
  it('should return 200 for health endpoint', async () => {
    const port = await getFreePort()
    const ctx = makeMockContext()
    const source = createHttpSource(makeUri(port))
    const iterator = source.start(ctx)[Symbol.asyncIterator]()
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
    const data = await healthRes.json()
    expect(data).toEqual({ status: 'ok' })
    // Unblock the generator by POSTing, then return it
    await fetch(`http://localhost:${port}/ingest`, { method: 'POST', body: '{}' }).catch(() => {})
    await iterator.return()
  })
  it('should stop cleanly when iterator returns', async () => {
    const port = await getFreePort()
    const ctx = makeMockContext()
    const source = createHttpSource(makeUri(port))
    const iterator = source.start(ctx)[Symbol.asyncIterator]()
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
    await iterator.return()
    // Verify server is stopped
    const healthRes = await fetch(`http://localhost:${port}/health`).catch(() => null)
    expect(healthRes?.ok).toBeFalsy()
  })
})
//# sourceMappingURL=http-server.test.js.map
