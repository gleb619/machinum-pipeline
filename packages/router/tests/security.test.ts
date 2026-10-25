import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tokenMatches } from '../server/middleware/auth.js'
import { startRouter } from '../server/standalone.js'
import { assertSafeBind, isLoopbackHost } from '../server/utils/bind-guard.js'
import { redact } from '../server/utils/redact.js'

describe('bind guard', () => {
  it.each(['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.5'])('%s is loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(true)
    expect(() => assertSafeBind(h, undefined)).not.toThrow()
  })

  it('refuses non-loopback without token, with a fix hint', () => {
    expect(() => assertSafeBind('0.0.0.0', undefined)).toThrow(/MT_ROUTER_TOKEN/)
    expect(() => assertSafeBind('10.0.0.2', '')).toThrow(/MT_ROUTER_TOKEN/)
  })

  it('allows non-loopback with token', () => {
    expect(() => assertSafeBind('0.0.0.0', 'tok')).not.toThrow()
  })

  it('startRouter rejects before listening', async () => {
    await expect(
      startRouter({ port: 0, host: '0.0.0.0', mock: true, token: undefined, apiKeys: [] }),
    ).rejects.toThrow(/MT_ROUTER_TOKEN/)
  })
})

describe('tokenMatches', () => {
  it('compares exactly', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abd', 'abc')).toBe(false)
    expect(tokenMatches('abcd', 'abc')).toBe(false)
    expect(tokenMatches('', 'abc')).toBe(false)
  })
})

describe('redact', () => {
  it('masks bearer-looking strings and sk- keys', () => {
    expect(redact('bad Bearer abcdef123456 and sk-live_abcdef12')).toBe('bad Bearer *** and ***')
  })
})

describe('keyless gateway security (live, fake upstream)', () => {
  const UPSTREAM_KEY = 'up-key-secret-123'
  const ROUTER_TOKEN = 'router-token-xyz'
  let fake: Server
  let dir: string
  let stop: () => Promise<void>
  let url: string
  let failNext = false
  const seen: IncomingHttpHeaders[] = []

  beforeAll(async () => {
    fake = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        seen.push(req.headers)
        if (failNext) {
          failNext = false
          res.statusCode = 500
          res.end(`invalid key ${UPSTREAM_KEY} / Bearer ${UPSTREAM_KEY}`)
          return
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: 'x', usage: { prompt_tokens: 1, completion_tokens: 1 } }))
      })
    })
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
    const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
    dir = await mkdtemp(join(tmpdir(), 'mt-router-sec-'))
    const handle = await startRouter({
      port: 0,
      host: '127.0.0.1',
      mock: false,
      vault: false,
      token: ROUTER_TOKEN,
      logDir: join(dir, 'logs'),
      apiKeys: [],
      upstreams: [
        { name: 'vllm', kind: 'openai-compat', baseUrl: `${fakeUrl}/v1`, keys: [UPSTREAM_KEY] },
      ],
    })
    url = handle.url
    stop = handle.close
  })

  afterAll(async () => {
    await stop()
    await new Promise<void>((r) => fake.close(() => r()))
    await rm(dir, { recursive: true, force: true })
  })

  const post = (headers: Record<string, string> = {}) =>
    fetch(`${url}/api/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'vllm/m', messages: [] }),
    })

  it('health is open; other /api routes need the token', async () => {
    expect((await fetch(`${url}/api/health`)).status).toBe(200)
    for (const path of ['/api/pool', '/api/dashboard', '/api/logs']) {
      const res = await fetch(`${url}${path}`)
      expect(res.status).toBe(401)
    }
    expect((await post()).status).toBe(401)
    expect((await post({ authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await post({ authorization: 'Basic abc' })).status).toBe(401)
    const ok = await fetch(`${url}/api/pool`, {
      headers: { authorization: `Bearer ${ROUTER_TOKEN}` },
    })
    expect(ok.status).toBe(200)
  })

  it('never forwards client credentials; upstream gets only its own key', async () => {
    const before = seen.length
    const res = await post({
      authorization: `Bearer ${ROUTER_TOKEN}`,
      'x-api-key': 'client-x-api-key',
      cookie: 'session=client-cookie',
    })
    expect(res.status).toBe(200)
    const h = seen.at(-1) as IncomingHttpHeaders
    expect(seen.length).toBe(before + 1)
    expect(h.authorization).toBe(`Bearer ${UPSTREAM_KEY}`)
    expect(h['x-api-key']).toBeUndefined()
    expect(h.cookie).toBeUndefined()
    expect(JSON.stringify(h)).not.toContain(ROUTER_TOKEN)
  })

  it('scrubs upstream error echo, keeps rate-limit header path intact', async () => {
    failNext = true
    const res = await post({ authorization: `Bearer ${ROUTER_TOKEN}` })
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).not.toContain(UPSTREAM_KEY)
    expect(text).toContain('***')
    expect(res.headers.get('x-ratelimit-remaining')).not.toBeNull()
  })

  it('log output carries no key values', async () => {
    const day = new Date().toISOString().split('T')[0] as string
    const log = await readFile(join(dir, 'logs', day, 'log.jsonl'), 'utf-8')
    expect(log).not.toContain(UPSTREAM_KEY)
    expect(log).not.toContain(ROUTER_TOKEN)
  })
})
