import { mkdtemp, rm } from 'node:fs/promises'
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startRouter } from '../server/standalone.js'

interface Seen {
  headers: IncomingHttpHeaders
  body: { model: string; messages: Array<{ role: string; content: string }> }
}

describe('/api/translate routes via upstream registry (fake upstreams)', () => {
  const TOKEN = 'router-token-t124'
  const VLLM_KEY = 'vllm-key-t124'
  const servers: Server[] = []
  const ollamaSeen: Seen[] = []
  const vllmSeen: Seen[] = []
  let dir: string
  let stop: () => Promise<void>
  let url: string

  const fake = async (sink: Seen[]): Promise<string> => {
    const srv = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Seen['body']
        sink.push({ headers: req.headers, body })
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            choices: [{ message: { content: `T(${body.messages[1]?.content})` } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        )
      })
    })
    servers.push(srv)
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  }

  beforeAll(async () => {
    const ollamaUrl = await fake(ollamaSeen)
    const vllmUrl = await fake(vllmSeen)
    dir = await mkdtemp(join(tmpdir(), 'mt-router-tr-'))
    const handle = await startRouter({
      port: 0,
      host: '127.0.0.1',
      mock: false,
      vault: false,
      token: TOKEN,
      logDir: join(dir, 'logs'),
      apiKeys: [],
      upstreams: [
        { name: 'ollama', kind: 'ollama', baseUrl: ollamaUrl },
        {
          name: 'vllm',
          kind: 'openai-compat',
          baseUrl: `${vllmUrl}/v1`,
          keys: [VLLM_KEY],
          headers: { 'X-Custom': 'yes' },
        },
      ],
    })
    url = handle.url
    stop = handle.close
  })

  afterAll(async () => {
    await stop()
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()))
    await rm(dir, { recursive: true, force: true })
  })

  const post = (payload: unknown, query = '') =>
    fetch(`${url}/api/translate${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(payload),
    })

  it('ollama/<m>: prefix stripped, no Authorization, token never forwarded', async () => {
    const res = await post({ text: 'hi', targetLang: 'fr', model: 'ollama/llama3.1' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { translatedText: string; model: string; tokens: number }
    expect(json).toEqual({ translatedText: 'T(hi)', model: 'ollama/llama3.1', tokens: 5 })
    const s = ollamaSeen.at(-1) as Seen
    expect(s.body.model).toBe('llama3.1')
    expect(s.body.messages[0]?.content).toContain('fr')
    expect(s.headers.authorization).toBeUndefined()
    expect(JSON.stringify(s.headers)).not.toContain(TOKEN)
  })

  it('keyed upstream gets its own key and headers; apiKeys body override ignored', async () => {
    const res = await post({
      text: 'yo',
      targetLang: 'de',
      model: 'vllm/m1',
      apiKeys: ['client-supplied-key'],
    })
    expect(res.status).toBe(200)
    const s = vllmSeen.at(-1) as Seen
    expect(s.body.model).toBe('m1')
    expect(s.headers.authorization).toBe(`Bearer ${VLLM_KEY}`)
    expect(s.headers['x-custom']).toBe('yes')
    expect(JSON.stringify(s.headers)).not.toContain('client-supplied-key')
  })

  it('batch works through a routed upstream', async () => {
    const before = ollamaSeen.length
    const res = await post({ text: ['a', 'b'], targetLang: 'es', model: 'ollama/m' })
    const json = (await res.json()) as { results: Array<{ translatedText: string }> }
    expect(json.results.map((r) => r.translatedText)).toEqual(['T(a)', 'T(b)'])
    expect(ollamaSeen.length).toBe(before + 2)
  })

  it('bare id goes to the default upstream, not the others', async () => {
    const o = ollamaSeen.length
    const v = vllmSeen.length
    const res = await post({ text: 'x', targetLang: 'fr', model: 'openai/gpt-4o-mini' })
    expect(res.status).toBe(503)
    expect(ollamaSeen.length).toBe(o)
    expect(vllmSeen.length).toBe(v)
  })
})
