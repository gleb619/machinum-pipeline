import { type Server, createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireListener } from '../src/http-listener.js'

const releases: Array<() => Promise<void>> = []

async function acquire(host: string, port: number) {
  const lease = await acquireListener(host, port)
  releases.push(() => lease.release())
  return lease
}

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

afterEach(async () => {
  while (releases.length > 0) {
    const release = releases.pop()
    if (release) await release()
  }
})

describe('shared HTTP listener registry', () => {
  it('shares one server across leases on the same host:port', async () => {
    const port = await getFreePort()
    const first = await acquire('127.0.0.1', port)
    const second = await acquire('127.0.0.1', port)

    expect(second.server).toBe(first.server)
    expect(second.port).toBe(port)
    expect(first.shared).toBe(false)
    expect(second.shared).toBe(true)
  })

  it('keeps the listener open until the last release', async () => {
    const port = await getFreePort()
    const first = await acquire('127.0.0.1', port)
    const second = await acquire('127.0.0.1', port)

    second.addRoute('/ping', (_req, res) => {
      res.end('pong')
    })

    await first.release()
    const response = await fetch(`http://127.0.0.1:${port}/ping`)
    expect(await response.text()).toBe('pong')

    await second.release()
    await expect(fetch(`http://127.0.0.1:${port}/ping`)).rejects.toThrow()
  })

  it('dispatches exact routes before the fallback and removes routes on dispose', async () => {
    const lease = await acquire('127.0.0.1', 0)
    lease.addRoute('*', (_req, res) => {
      res.end('fallback')
    })
    const dispose = lease.addRoute('/exact', (_req, res) => {
      res.end('exact')
    })

    expect(await (await fetch(`http://127.0.0.1:${lease.port}/exact`)).text()).toBe('exact')
    expect(await (await fetch(`http://127.0.0.1:${lease.port}/other`)).text()).toBe('fallback')

    dispose()
    expect(await (await fetch(`http://127.0.0.1:${lease.port}/exact`)).text()).toBe('fallback')

    expect(() =>
      lease.addRoute('/exact', (_req, res) => {
        res.end('again')
      }),
    ).not.toThrow()
  })

  it('rejects duplicate exact routes on one listener', async () => {
    const lease = await acquire('127.0.0.1', 0)
    lease.addRoute('/ingest', (_req, res) => {
      res.end('first')
    })
    expect(() =>
      lease.addRoute('/ingest', (_req, res) => {
        res.end('second')
      }),
    ).toThrow(/already registered on 127\.0\.0\.1:\d+/)
  })

  it('shares a wildcard listener with a loopback request', async () => {
    const port = await getFreePort()
    const wildcard = await acquire('0.0.0.0', port)
    const loopback = await acquire('127.0.0.1', port)
    expect(loopback.server).toBe(wildcard.server)
  })

  it('reports a foreign process with a clear EADDRINUSE message naming host:port', async () => {
    const foreign: Server = createServer()
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', () => resolve()))
    const port = (foreign.address() as { port: number }).port

    try {
      await expect(acquireListener('127.0.0.1', port)).rejects.toMatchObject({
        code: 'EADDRINUSE',
        message: expect.stringContaining(`127.0.0.1:${port}`),
      })
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()))
    }
  })
})
