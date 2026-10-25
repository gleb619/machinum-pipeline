import { mkdtemp, rm } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startRouter } from '../server/standalone.js'

describe('GET /api/models (fake upstreams)', () => {
  const KEY = 'up-key-secret-999'
  const TOKEN = 'tok-models'
  let fake: Server
  let dir: string
  let stop: () => Promise<void>
  let url: string

  beforeAll(async () => {
    fake = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'live-a' }, { id: 'cfg-b' }] }))
      } else if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'gemma4:latest' }] }))
      } else {
        res.statusCode = 404
        res.end(`nope ${KEY}`)
      }
    })
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
    const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
    dir = await mkdtemp(join(tmpdir(), 'mt-router-models-'))
    const handle = await startRouter({
      port: 0,
      host: '127.0.0.1',
      mock: false,
      vault: false,
      token: TOKEN,
      logDir: join(dir, 'logs'),
      apiKeys: [],
      upstreams: [
        {
          name: 'vllm',
          kind: 'openai-compat',
          baseUrl: `${fakeUrl}/v1`,
          keys: [KEY],
          models: ['cfg-b', 'cfg-c'],
        },
        { name: 'ol', kind: 'ollama', baseUrl: fakeUrl },
        { name: 'dead', kind: 'openai-compat', baseUrl: 'http://127.0.0.1:1/v1', models: ['x'] },
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

  it('needs the token', async () => {
    expect((await fetch(`${url}/api/models`)).status).toBe(401)
  })

  it('lists routable ids, merges live + configured, survives dead upstream', async () => {
    const res = await fetch(`${url}/api/models`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(KEY)
    const body = JSON.parse(text) as {
      object: string
      data: Array<{ id: string; object: string; owned_by: string }>
    }
    expect(body.object).toBe('list')
    const ids = body.data.map((m) => m.id)
    expect(ids).toContain('openrouter/free')
    expect(ids).toEqual(
      expect.arrayContaining([
        'vllm/live-a',
        'vllm/cfg-b',
        'vllm/cfg-c',
        'ol/gemma4:latest',
        'dead/x',
      ]),
    )
    expect(ids.filter((i) => i === 'vllm/cfg-b')).toHaveLength(1)
    expect(body.data.find((m) => m.id === 'vllm/live-a')).toEqual({
      id: 'vllm/live-a',
      object: 'model',
      owned_by: 'vllm',
    })
  })
})
