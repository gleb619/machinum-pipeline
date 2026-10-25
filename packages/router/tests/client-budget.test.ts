import { mkdtemp, rm } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startRouter } from '../server/standalone.js'
import { sanitizeClientId } from '../server/utils/client-id.js'
import { logCall } from '../server/utils/cost-tracker.js'

describe('sanitizeClientId', () => {
  it('sanitises, caps and defaults', () => {
    expect(sanitizeClientId(undefined)).toBe('anonymous')
    expect(sanitizeClientId('   ')).toBe('anonymous')
    expect(sanitizeClientId('team a/b<script>')).toBe('team_a_b_script_')
    expect(sanitizeClientId('x'.repeat(200))).toHaveLength(64)
  })
})

describe('per-client budget (fake upstream)', () => {
  const TOKEN = 'tok-t128'
  let fake: Server
  let dir: string
  let off: { url: string; stop: () => Promise<void> }
  let on: { url: string; stop: () => Promise<void> }

  const boot = async (fakeUrl: string, clientBudget: number | undefined, dailyBudget = 100) => {
    const handle = await startRouter({
      port: 0,
      host: '127.0.0.1',
      mock: false,
      vault: false,
      token: TOKEN,
      logDir: join(dir, `logs-${clientBudget}-${dailyBudget}`),
      apiKeys: [],
      dailyBudget,
      clientBudget,
      upstreams: [{ name: 'vllm', kind: 'openai-compat', baseUrl: `${fakeUrl}/v1`, keys: ['k'] }],
    })
    return { url: handle.url, stop: handle.close }
  }

  const post = (url: string, client?: string) =>
    fetch(`${url}/api/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        ...(client === undefined ? {} : { 'x-mt-client': client }),
      },
      body: JSON.stringify({ model: 'vllm/m', messages: [] }),
    })

  // 1M prompt tokens = $1 (logCall pricing); upstream is free so only seeded rows cost money.
  const spend = (client: string | undefined, dollars: number) =>
    logCall(null, null, 'm', { promptTokens: dollars * 1_000_000, completionTokens: 0 }, { client })

  beforeAll(async () => {
    fake = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: 'x', usage: { prompt_tokens: 1, completion_tokens: 1 } }))
      })
    })
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
    const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
    dir = await mkdtemp(join(tmpdir(), 'mt-router-cb-'))
    off = await boot(fakeUrl, undefined)
    await spend('big', 50)
  })

  afterAll(async () => {
    await off.stop()
    await on?.stop()
    await new Promise<void>((r) => fake.close(() => r()))
    await rm(dir, { recursive: true, force: true })
  })

  it('off by default: no 429, no client header', async () => {
    const res = await post(off.url, 'big')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-ratelimit-client-remaining')).toBeNull()
  })

  it('client over budget gets 429 + Retry-After, others still 200', async () => {
    const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
    on = await boot(fakeUrl, 1)
    await spend('A', 2)
    await spend('B', 0.1)
    const a = await post(on.url, 'A')
    expect(a.status).toBe(429)
    expect(Number(a.headers.get('retry-after'))).toBeGreaterThan(0)
    const body = (await a.json()) as { error: string; client: string; retryAfter: number }
    expect(body.client).toBe('A')
    expect(body.retryAfter).toBeGreaterThan(0)
    const b = await post(on.url, 'B')
    expect(b.status).toBe(200)
    expect(Number(b.headers.get('x-ratelimit-client-remaining'))).toBeCloseTo(0.9, 3)
    // translate path is limited too
    const t = await fetch(`${on.url}/api/translate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        'x-mt-client': 'A',
      },
      body: JSON.stringify({ text: 'hi', targetLang: 'de' }),
    })
    expect(t.status).toBe(429)
  })

  it('missing header uses anonymous bucket; garbage header is sanitised', async () => {
    await spend(undefined, 3)
    expect((await post(on.url)).status).toBe(429)
    const res = await post(on.url, 'bad<>id')
    expect(res.status).toBe(200)
    // calls are logged under the sanitised id and shown in the dashboard without keys
    const dash = await fetch(`${on.url}/api/dashboard`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const json = (await dash.json()) as {
      clients: Record<string, { calls: number; cost: number }>
      clientBudgetLimit: number
    }
    expect(json.clientBudgetLimit).toBe(1)
    expect(json.clients.A?.cost).toBeCloseTo(2, 3)
    expect(json.clients.bad__id?.calls).toBe(1)
    expect(JSON.stringify(json)).not.toContain(TOKEN)
  })

  it('global budget wins over the client check', async () => {
    const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
    const g = await boot(fakeUrl, 1000, 1)
    try {
      await spend('G', 2)
      const res = await post(g.url, 'G')
      expect(res.status).toBe(429)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('Daily budget exceeded')
    } finally {
      await g.stop()
    }
  })
})
