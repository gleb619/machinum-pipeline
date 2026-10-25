import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startRouter } from '../server/standalone.js'
import { buildRegistry, upstreamSpecsFromEnv } from '../server/utils/upstream.js'

describe('resolve(model)', () => {
  const registry = buildRegistry(
    ['k1'],
    [
      { name: 'ollama', kind: 'ollama', baseUrl: 'http://localhost:11434' },
      { name: 'vllm', kind: 'openai-compat', baseUrl: 'http://x/v1', keys: ['s'] },
    ],
  )

  it('routes ollama/<m> to ollama and strips the prefix', () => {
    const r = registry.resolve('ollama/gemma4:latest')
    expect(r.upstream.name).toBe('ollama')
    expect(r.upstream.baseUrl).toBe('http://localhost:11434/v1')
    expect(r.upstream.keyless).toBe(true)
    expect(r.upstreamModel).toBe('gemma4:latest')
  })

  it('routes named entries and keeps keys flag', () => {
    const r = registry.resolve('vllm/llama/3')
    expect(r.upstream.name).toBe('vllm')
    expect(r.upstream.keyless).toBe(false)
    expect(r.upstreamModel).toBe('llama/3')
  })

  it.each(['openrouter/free', 'openrouter/auto', 'openai/gpt-4o-mini', 'bare', 'nope/x'])(
    '%s goes to default untouched',
    (model) => {
      const r = registry.resolve(model)
      expect(r.upstream.name).toBe('openrouter')
      expect(r.upstreamModel).toBe(model)
    },
  )

  it('reserves the default name', () => {
    expect(() =>
      registry.register({ name: 'openrouter', kind: 'openai-compat', baseUrl: 'x' }),
    ).toThrow()
  })

  it('parses env specs', () => {
    const specs = upstreamSpecsFromEnv({
      MT_ROUTER_UPSTREAMS: JSON.stringify([
        { name: 'a', kind: 'openai-compat', baseUrl: 'http://a/v1' },
        { name: 'bad', kind: 'nope', baseUrl: 'x' },
      ]),
      MT_ROUTER_OLLAMA_URL: 'http://gpu:11434',
    })
    expect(specs.map((s) => s.name)).toEqual(['a', 'ollama'])
  })
})

describe('handler routing (live mode, fake upstream)', () => {
  let fake: Server
  let fakeUrl: string
  let dir: string
  let stop: () => Promise<void>
  let url: string
  const seen: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown>; path: string }> =
    []

  beforeAll(async () => {
    fake = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => {
        raw += c
      })
      req.on('end', () => {
        seen.push({ headers: req.headers, body: JSON.parse(raw), path: req.url ?? '' })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: 'x', usage: { prompt_tokens: 10, completion_tokens: 5 } }))
      })
    })
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
    fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
    dir = await mkdtemp(join(tmpdir(), 'mt-router-up-'))
    const handle = await startRouter({
      port: 0,
      host: '127.0.0.1',
      mock: false,
      logDir: join(dir, 'logs'),
      apiKeys: [],
      upstreams: [
        { name: 'ollama', kind: 'ollama', baseUrl: fakeUrl },
        { name: 'vllm', kind: 'openai-compat', baseUrl: `${fakeUrl}/v1`, keys: ['secret-key'] },
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

  const post = (model: string) =>
    fetch(`${url}/api/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [] }),
    })

  it('ollama/<m>: no Authorization, prefix stripped, cost 0, upstream logged', async () => {
    const res = await post('ollama/gemma4:latest')
    expect(res.status).toBe(200)
    const call = seen.at(-1)
    expect(call?.path).toBe('/v1/chat/completions')
    expect(call?.body.model).toBe('gemma4:latest')
    expect(call?.headers.authorization).toBeUndefined()
    await new Promise((r) => setTimeout(r, 100))
    const day = new Date().toISOString().split('T')[0] as string
    const lines = (await readFile(join(dir, 'logs', day, 'log.jsonl'), 'utf-8')).trim().split('\n')
    const entry = JSON.parse(lines.at(-1) as string)
    expect(entry).toMatchObject({ model: 'ollama/gemma4:latest', cost: 0, upstream: 'ollama' })
  })

  it('keyed openai-compat upstream sends Bearer', async () => {
    await post('vllm/m1')
    const call = seen.at(-1)
    expect(call?.headers.authorization).toBe('Bearer secret-key')
    expect(call?.body.model).toBe('m1')
  })

  it('default upstream without keys stays 503 and never hits fake', async () => {
    const before = seen.length
    const res = await post('openrouter/free')
    expect(res.status).toBe(503)
    expect(seen.length).toBe(before)
  })

  it('pool endpoint lists upstreams without key values', async () => {
    const text = await (await fetch(`${url}/api/pool`)).text()
    expect(text).not.toContain('secret-key')
    expect(JSON.parse(text).upstreams.map((u: { name: string }) => u.name)).toEqual([
      'openrouter',
      'ollama',
      'vllm',
    ])
  })
})
