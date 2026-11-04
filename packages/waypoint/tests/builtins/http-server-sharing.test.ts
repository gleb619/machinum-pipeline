import { type Server, createServer } from 'node:http'
import type { SourceContext } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { describe, expect, it, vi } from 'vitest'
import { createHttpSource } from '../../src/http-server.js'

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

function makeUri(port: number, path: string): ParsedUri {
  return {
    raw: `hs://127.0.0.1:${port}${path}`,
    scheme: 'hs',
    host: `127.0.0.1:${port}`,
    path,
    query: { port: String(port) },
    fragment: '',
  }
}

function makeMockContext() {
  return {
    run: {
      global: { env: {} },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    },
  }
}

describe('http-server — shared listener', () => {
  it('lets two hs:// sources share one port and namespaces health/events when shared', async () => {
    const port = await getFreePort()
    const firstCtx = makeMockContext()
    const secondCtx = makeMockContext()
    const first = createHttpSource<{ id: number }>(makeUri(port, '/ingest-one'))
    const second = createHttpSource<{ id: number }>(makeUri(port, '/ingest-two'))
    const firstIterator = first.start(firstCtx as SourceContext)[Symbol.asyncIterator]()
    const secondIterator = second.start(secondCtx as SourceContext)[Symbol.asyncIterator]()

    const firstNext = firstIterator.next()
    const secondNext = secondIterator.next()
    await vi.waitFor(
      () => {
        expect(firstCtx.run.logger.info).toHaveBeenCalled()
        expect(secondCtx.run.logger.info).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 20 },
    )

    const firstPost = await fetch(`http://127.0.0.1:${port}/ingest-one`, {
      method: 'POST',
      body: JSON.stringify({ id: 1 }),
    })
    const secondPost = await fetch(`http://127.0.0.1:${port}/ingest-two`, {
      method: 'POST',
      body: JSON.stringify({ id: 2 }),
    })
    expect(firstPost.status).toBe(200)
    expect(secondPost.status).toBe(200)
    expect((await firstNext).value).toMatchObject({ item: { id: 1 } })
    expect((await secondNext).value).toMatchObject({ item: { id: 2 } })

    // First lease was alone: unnamespaced health. Second lease is shared: namespaced health.
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${port}/ingest-two/health`)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${port}/ingest-two/events`)).status).toBe(200)

    await firstIterator.return?.()
    await secondIterator.return?.()
  })

  it('rejects an ingest path under /api/* when the source opens', async () => {
    const port = await getFreePort()
    const source = createHttpSource(makeUri(port, '/api/ingest'))
    const iterator = source.start(makeMockContext() as SourceContext)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow(/collides with the \/api\/\* admin namespace/)
  })

  it('rejects a duplicate ingest route on the same shared listener', async () => {
    const port = await getFreePort()
    const first = createHttpSource(makeUri(port, '/ingest'))
    const second = createHttpSource(makeUri(port, '/ingest'))
    const firstCtx = makeMockContext()
    const firstIterator = first.start(firstCtx as SourceContext)[Symbol.asyncIterator]()
    firstIterator.next().catch(() => {})
    await vi.waitFor(
      () => {
        expect(firstCtx.run.logger.info).toHaveBeenCalled()
      },
      { timeout: 3000, interval: 20 },
    )

    const secondIterator = second.start(makeMockContext() as SourceContext)[Symbol.asyncIterator]()
    await expect(secondIterator.next()).rejects.toThrow(/already registered/)
    await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ id: 1 }),
    })
    await firstIterator.return?.()
  })

  it('keeps a clear EADDRINUSE error naming host:port for a foreign process', async () => {
    const foreign: Server = createServer()
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', () => resolve()))
    const port = (foreign.address() as { port: number }).port

    try {
      const source = createHttpSource(makeUri(port, '/ingest'))
      const iterator = source.start(makeMockContext() as SourceContext)[Symbol.asyncIterator]()
      await expect(iterator.next()).rejects.toThrow(
        new RegExp(`127\\.0\\.0\\.1:${port}.*EADDRINUSE`),
      )
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()))
    }
  })
})
