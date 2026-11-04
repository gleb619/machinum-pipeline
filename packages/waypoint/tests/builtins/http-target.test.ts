import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { Exchange, Logger, TargetContext, Vault } from '@mt/core'
import { registry } from '@mt/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpTarget } from '../../src/http-target.js'

interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

interface TestServer {
  origin: string
  requests: CapturedRequest[]
  close: () => Promise<void>
}

/** Local HTTP server on an ephemeral port — no network access, no fixed ports. */
async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string, call: number) => void = (
    _req,
    res,
  ) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  },
): Promise<TestServer> {
  const requests: CapturedRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      handler(req, res, body, requests.length)
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

interface LogRecord {
  level: string
  message: string
  meta?: Record<string, unknown>
}

function makeCtx(options: { env?: Record<string, string>; vault?: Vault } = {}): {
  ctx: TargetContext
  logs: LogRecord[]
} {
  const logs: LogRecord[] = []
  const push =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      logs.push({ level, message, ...(meta === undefined ? {} : { meta }) })
    }
  const logger: Logger = {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
  }
  const ctx = {
    run: {
      runId: 'run-1',
      pipelineId: 'pipe-1',
      startedAt: new Date(0).toISOString(),
      global: {
        project: { name: 'test', root: process.cwd() },
        defaults: {
          retry: { max: 0, backoffMs: 1, strategy: 'exp' },
          onError: 'fail-run',
          concurrency: 1,
        },
        settings: {},
        env: options.env ?? {},
        ...(options.vault === undefined ? {} : { vault: options.vault }),
      },
      logger,
    },
  } as unknown as TargetContext
  return { ctx, logs }
}

function makeEnv(overrides: Partial<Exchange<unknown>> = {}): Exchange<unknown> {
  return { id: 'ex-1', item: 'hello', meta: {}, variables: [], ...overrides }
}

const openServers: TestServer[] = []

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop()
    await server?.close()
  }
})

async function serve(handler?: Parameters<typeof startServer>[0]): Promise<TestServer> {
  const server = await startServer(handler)
  openServers.push(server)
  return server
}

describe('http target', () => {
  it('POSTs the exchange as JSON by default', async () => {
    const server = await serve()
    const { ctx } = makeCtx()
    const target = createHttpTarget<unknown>(registry.parse(`${server.origin}/ingest`))

    await target.open(ctx)
    await target.write(makeEnv({ id: 'ex-1', item: { text: 'hi' } }), ctx)
    await target.close(ctx)

    expect(server.requests).toHaveLength(1)
    const request = server.requests[0]
    expect(request?.method).toBe('POST')
    expect(request?.headers['x-mt-exchange-id']).toBe('ex-1')
    expect(request?.headers['content-type']).toBe('application/json')
    expect(JSON.parse(request?.body ?? '')).toEqual({
      id: 'ex-1',
      item: { text: 'hi' },
      meta: {},
      variables: [],
    })
  })

  it('sends the configured method', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const server = await serve()
      const { ctx } = makeCtx()
      const target = createHttpTarget<unknown>(
        registry.parse(`${server.origin}/ingest?method=${method}`),
      )
      await target.open(ctx)
      await target.write(makeEnv(), ctx)
      expect(server.requests[0]?.method).toBe(method)
    }
  })

  it('rejects body-less methods at parse time', () => {
    expect(() => createHttpTarget(registry.parse('http://example.com/x?method=GET'))).toThrow(
      /method 'GET'/,
    )
    expect(() => createHttpTarget(registry.parse('http://example.com/x?method=HEAD'))).toThrow(
      /method 'HEAD'/,
    )
  })

  it('rejects an unknown method at parse time', () => {
    expect(() => createHttpTarget(registry.parse('http://example.com/x?method=TRACE'))).toThrow(
      /method 'TRACE'/,
    )
  })

  it('sends only the item with contentType=item', async () => {
    const server = await serve()
    const { ctx } = makeCtx()
    const target = createHttpTarget<unknown>(
      registry.parse(`${server.origin}/ingest?contentType=item`),
    )

    await target.open(ctx)
    await target.write(makeEnv({ item: { text: 'hi' } }), ctx)

    expect(JSON.parse(server.requests[0]?.body ?? '')).toEqual({ text: 'hi' })
  })

  it('sends plain text with contentType=text', async () => {
    const server = await serve()
    const { ctx } = makeCtx()
    const target = createHttpTarget<unknown>(
      registry.parse(`${server.origin}/ingest?contentType=text`),
    )

    await target.open(ctx)
    await target.write(makeEnv({ item: 'plain text' }), ctx)

    expect(server.requests[0]?.body).toBe('plain text')
    expect(server.requests[0]?.headers['content-type']).toBe('text/plain; charset=utf-8')
  })

  it('sends one request per batch with items[] when batch=true', async () => {
    const server = await serve()
    const { ctx } = makeCtx()
    const target = createHttpTarget<unknown>(registry.parse(`${server.origin}/ingest?batch=true`))

    await target.open(ctx)
    await target.write(makeEnv({ id: 'ex-2', item: ['a', 'b'], items: ['a', 'b'] }), ctx)

    expect(server.requests).toHaveLength(1)
    expect(JSON.parse(server.requests[0]?.body ?? '')).toEqual({
      id: 'ex-2',
      items: ['a', 'b'],
      meta: {},
      variables: [],
    })
  })

  it('sends extra static headers', async () => {
    const server = await serve()
    const { ctx } = makeCtx()
    const target = createHttpTarget<unknown>(
      registry.parse(`${server.origin}/ingest?header.X-Foo=bar`),
    )

    await target.open(ctx)
    await target.write(makeEnv(), ctx)

    expect(server.requests[0]?.headers['x-foo']).toBe('bar')
  })

  it('never forwards control parameters to the server', async () => {
    const server = await serve()
    const { ctx } = makeCtx({ env: { MT_TOKEN: 'secret-token' } })
    const target = createHttpTarget<unknown>(
      registry.parse(`${server.origin}/ingest?method=PUT&bearer=MT_TOKEN&timeoutMs=1000`),
    )

    await target.open(ctx)
    await target.write(makeEnv(), ctx)

    expect(server.requests[0]?.url).toBe('/ingest')
  })

  it('resolves the bearer reference from the environment', async () => {
    const server = await serve()
    const { ctx } = makeCtx({ env: { MT_REMOTE_TOKEN: 'secret-token' } })
    const target = createHttpTarget<unknown>(
      registry.parse(`${server.origin}/ingest?bearer=MT_REMOTE_TOKEN`),
    )

    await target.open(ctx)
    await target.write(makeEnv(), ctx)

    expect(server.requests[0]?.headers.authorization).toBe('Bearer secret-token')
  })

  it('resolves the bearer reference from the vault', async () => {
    const server = await serve()
    const vault = {
      version: 1,
      entries: { remote: { provider: 'custom', apiKey: 'vault-token' } },
    } as unknown as Vault
    const { ctx } = makeCtx({ vault })
    const target = createHttpTarget<unknown>(
      registry.parse(`${server.origin}/ingest?bearer=remote`),
    )

    await target.open(ctx)
    await target.write(makeEnv(), ctx)

    expect(server.requests[0]?.headers.authorization).toBe('Bearer vault-token')
  })

  it('fails at open() when the bearer reference cannot be resolved', async () => {
    const { ctx } = makeCtx()
    const target = createHttpTarget<unknown>(
      registry.parse('http://example.com/ingest?bearer=MT_MISSING_TOKEN'),
    )

    await expect(target.open(ctx)).rejects.toThrow(/MT_MISSING_TOKEN/)
  })

  it('rejects an inline token as bearer reference', () => {
    expect(() =>
      createHttpTarget(registry.parse('http://example.com/ingest?bearer=eyJhbGciOi.payload.sig')),
    ).toThrow(/bearer/)
  })

  it('retries a 503 and succeeds', async () => {
    const server = await serve((_req, res, _body, call) => {
      if (call === 1) {
        res.writeHead(503)
        res.end('unavailable')
        return
      }
      res.writeHead(200)
      res.end('ok')
    })
    const { ctx } = makeCtx()
    const target = createHttpTarget<unknown>(registry.parse(`${server.origin}/ingest?retries=2`))

    await target.open(ctx)
    await target.write(makeEnv(), ctx)

    expect(server.requests).toHaveLength(2)
  })

  it('honours Retry-After on a 429', async () => {
    const server = await serve((_req, res, _body, call) => {
      if (call === 1) {
        res.writeHead(429, { 'Retry-After': '1' })
        res.end('slow down')
        return
      }
      res.writeHead(200)
      res.end('ok')
    })
    const { ctx } = makeCtx()
    const target = createHttpTarget<unknown>(registry.parse(`${server.origin}/ingest?retries=2`))

    const startedAt = Date.now()
    await target.open(ctx)
    await target.write(makeEnv(), ctx)
    const elapsed = Date.now() - startedAt

    expect(server.requests).toHaveLength(2)
    expect(elapsed).toBeGreaterThanOrEqual(1000)
  })

  it('fails the item on a 400 without retrying', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(400)
      res.end('bad request')
    })
    const { ctx } = makeCtx()
    const target = createHttpTarget<unknown>(registry.parse(`${server.origin}/ingest?retries=3`))

    await target.open(ctx)
    await expect(target.write(makeEnv(), ctx)).rejects.toThrow(/400/)

    expect(server.requests).toHaveLength(1)
  })

  it('treats a redirect as a failure', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(302, { Location: '/elsewhere' })
      res.end()
    })
    const { ctx } = makeCtx()
    const target = createHttpTarget<unknown>(registry.parse(`${server.origin}/ingest`))

    await target.open(ctx)
    await expect(target.write(makeEnv(), ctx)).rejects.toThrow(/30[0-9]/)
  })

  it('times out a hanging request', async () => {
    const server = await serve(() => {
      // never responds
    })
    const { ctx } = makeCtx()
    const target = createHttpTarget<unknown>(
      registry.parse(`${server.origin}/ingest?timeoutMs=80&retries=0`),
    )

    await target.open(ctx)
    await expect(target.write(makeEnv(), ctx)).rejects.toThrow(/timed out/)
  })

  it('masks secret query values in log lines', async () => {
    const server = await serve()
    const { ctx, logs } = makeCtx()
    const target = createHttpTarget<unknown>(
      registry.parse(`${server.origin}/ingest?api_key=sk-abcdef1234567890`),
    )

    await target.open(ctx)
    await target.write(makeEnv(), ctx)

    const rendered = JSON.stringify(logs)
    expect(rendered).not.toContain('sk-abcdef1234567890')
    expect(rendered).toContain('***')
  })

  it('counts only 2xx-acked exchanges in the checkpoint', async () => {
    let call = 0
    const server = await serve((_req, res) => {
      call += 1
      if (call === 1) {
        res.writeHead(200)
        res.end('ok')
        return
      }
      res.writeHead(400)
      res.end('bad')
    })
    const { ctx } = makeCtx()
    const target = createHttpTarget<unknown>(registry.parse(`${server.origin}/ingest`))

    await target.open(ctx)
    await target.write(makeEnv({ id: 'ex-1' }), ctx)
    expect(await target.checkpoint?.(ctx)).toBe(1)

    await expect(target.write(makeEnv({ id: 'ex-2' }), ctx)).rejects.toThrow()
    expect(await target.checkpoint?.(ctx)).toBe(1)
  })

  it('refuses to write before open()', async () => {
    const { ctx } = makeCtx()
    const target = createHttpTarget<unknown>(registry.parse('http://example.com/ingest'))

    await expect(target.write(makeEnv(), ctx)).rejects.toThrow(/open\(\)/)
  })
})

describe('http target registration', () => {
  it('registers http:// and https:// as targets', () => {
    expect(registry.getTargetSchemes()).toContain('http')
    expect(registry.getTargetSchemes()).toContain('https')
    expect(() => registry.resolveTarget('http://example.com/x')).not.toThrow()
    expect(() => registry.resolveTarget('https://example.com/x')).not.toThrow()
  })

  it('does NOT register hs:// as a target', () => {
    expect(registry.getTargetSchemes()).not.toContain('hs')
    expect(() => registry.resolveTarget('hs://localhost:9876/ingest')).toThrow()
  })
})
