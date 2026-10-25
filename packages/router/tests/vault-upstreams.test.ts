import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRouter } from '../server/standalone.js'
import { readVaultEntries, vaultPaths } from '../server/utils/vault-reader.js'
import { mapVaultEntries } from '../server/utils/vault-upstreams.js'

const SECRET = 'sk-SUPER-SECRET-123'

describe('vault-reader', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-vault-reader-'))
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('MT_VAULT is the only file', () => {
    expect(vaultPaths('/p', { MT_VAULT: '/x/v.json', MT_HOME: '/h' })).toEqual(['/x/v.json'])
  })

  it('user then project, MT_HOME aware', () => {
    expect(vaultPaths('/p', { MT_HOME: '/h' })).toEqual(['/h/vault.json', '/p/.mt/vault.json'])
  })

  it('missing file => empty', () => {
    expect(readVaultEntries([join(dir, 'nope.json')])).toEqual({})
  })

  it('project overrides user by whole entry', async () => {
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    await writeFile(
      a,
      JSON.stringify({
        version: 1,
        entries: {
          x: { provider: 'ollama', baseUrl: 'http://a', models: ['m'] },
          y: { provider: 'ollama' },
        },
      }),
    )
    await writeFile(
      b,
      JSON.stringify({ version: 1, entries: { x: { provider: 'ollama', baseUrl: 'http://b' } } }),
    )
    const merged = readVaultEntries([a, b])
    expect(merged.x).toEqual({ provider: 'ollama', baseUrl: 'http://b' })
    expect(Object.keys(merged)).toEqual(['x', 'y'])
  })

  it('bad JSON error never contains content', async () => {
    const f = join(dir, 'bad.json')
    await writeFile(f, `{"version":1,"entries":{"a":{"apiKey":"${SECRET}"`)
    expect(() => readVaultEntries([f])).toThrow(/malformed JSON/)
    try {
      readVaultEntries([f])
    } catch (e) {
      expect(String(e)).not.toContain(SECRET)
    }
  })

  it('invalid entry error names entry, not value', async () => {
    const f = join(dir, 'inv.json')
    await writeFile(f, JSON.stringify({ version: 1, entries: { a: { provider: SECRET } } }))
    expect(() => readVaultEntries([f])).toThrow(/entry "a"/)
    try {
      readVaultEntries([f])
    } catch (e) {
      expect(String(e)).not.toContain(SECRET)
    }
  })
})

describe('mapVaultEntries', () => {
  it('maps providers to kinds, keys, headers, models', () => {
    const warn = vi.fn()
    const r = mapVaultEntries(
      {
        gpu: { provider: 'ollama', baseUrl: 'http://gpu:11434', models: ['g'] },
        local: { provider: 'ollama' },
        oa: {
          provider: 'openai',
          baseUrl: 'http://oa/v1',
          apiKey: 'k1',
          apiKeys: ['k2'],
          headers: { 'X-A': '1' },
          defaultModel: 'm',
        },
        cu: { provider: 'custom', baseUrl: 'http://cu/v1' },
        nobase: { provider: 'custom' },
        or: { provider: 'openrouter', apiKeys: ['o1', 'o2'] },
        an: { provider: 'anthropic', apiKey: 'a' },
        rt: { provider: 'router' },
        openrouter: { provider: 'custom', baseUrl: 'http://x' },
      },
      warn,
    )
    expect(r.specs.map((s) => [s.name, s.kind])).toEqual([
      ['gpu', 'ollama'],
      ['local', 'ollama'],
      ['oa', 'openai-compat'],
      ['cu', 'openai-compat'],
    ])
    expect(r.specs[0]?.models).toEqual(['g'])
    expect(r.specs[1]?.baseUrl).toBe('http://localhost:11434')
    expect(r.specs[2]).toMatchObject({ keys: ['k1', 'k2'], headers: { 'X-A': '1' } })
    expect(r.openRouterKeys).toEqual(['o1', 'o2'])
    expect(warn).toHaveBeenCalledTimes(3)
    for (const [msg] of warn.mock.calls) expect(String(msg)).not.toMatch(/k1|k2|o1|"a"/)
  })
})

describe('router with vault (fake upstream)', () => {
  let fake: Server
  let fakeUrl: string
  let dir: string
  let vaultFile: string
  let stop: () => Promise<void>
  let url: string
  const seen: Array<{ auth?: string; path: string; body: Record<string, unknown> }> = []
  const prevVault = process.env.MT_VAULT

  const writeVault = async (entries: unknown, bump = 0) => {
    await writeFile(vaultFile, JSON.stringify({ version: 1, entries }))
    const t = new Date(Date.now() + bump)
    await utimes(vaultFile, t, t)
  }
  const post = (model: string) =>
    fetch(`${url}/api/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [] }),
    })

  beforeAll(async () => {
    fake = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => {
        raw += c
      })
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, path: req.url ?? '', body: JSON.parse(raw) })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: 'x', usage: { prompt_tokens: 1, completion_tokens: 1 } }))
      })
    })
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
    fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
    dir = await mkdtemp(join(tmpdir(), 'mt-router-vault-'))
    vaultFile = join(dir, 'vault.json')
    process.env.MT_VAULT = vaultFile
  })

  beforeEach(async () => {
    if (stop) await stop()
    await writeVault({
      box: { provider: 'ollama', baseUrl: fakeUrl },
      ai: {
        provider: 'openai',
        baseUrl: `${fakeUrl}/v1`,
        apiKey: SECRET,
        headers: { 'X-V': 'yes' },
      },
    })
    const handle = await startRouter({
      port: 0,
      host: '127.0.0.1',
      mock: false,
      vault: true,
      logDir: join(dir, 'logs'),
      apiKeys: [],
      upstreams: [],
    })
    url = handle.url
    stop = handle.close
  })

  afterAll(async () => {
    await stop()
    await new Promise<void>((r) => fake.close(() => r()))
    if (prevVault === undefined) process.env.MT_VAULT = undefined
    else process.env.MT_VAULT = prevVault
    await rm(dir, { recursive: true, force: true })
  })

  it('routes to vault ollama and openai entries', async () => {
    expect((await post('box/gemma:1')).status).toBe(200)
    expect(seen.at(-1)).toMatchObject({ auth: undefined, path: '/v1/chat/completions' })
    expect(seen.at(-1)?.body.model).toBe('gemma:1')
    expect((await post('ai/m')).status).toBe(200)
    expect(seen.at(-1)?.auth).toBe(`Bearer ${SECRET}`)
  })

  it('never leaks key values in pool, health, dashboard', async () => {
    for (const p of ['/api/pool', '/api/health', '/api/dashboard']) {
      const text = await (await fetch(`${url}${p}`)).text()
      expect(text).not.toContain(SECRET)
    }
    const health = await (await fetch(`${url}/api/health`)).json()
    expect(health.vault.entries).toEqual(['box', 'ai'])
  })

  it('hot reload adds an upstream; corrupt file keeps the previous registry', async () => {
    expect((await post('late/m')).status).toBe(503)
    await writeVault(
      {
        box: { provider: 'ollama', baseUrl: fakeUrl },
        late: { provider: 'ollama', baseUrl: fakeUrl },
      },
      5000,
    )
    expect((await post('late/m')).status).toBe(200)

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await writeFile(vaultFile, `{"version":1,"entries":{"x":{"apiKey":"${SECRET}"`)
    const t = new Date(Date.now() + 10_000)
    await utimes(vaultFile, t, t)
    expect((await post('late/m')).status).toBe(200)
    const logged = err.mock.calls.flat().join('\n')
    err.mockRestore()
    expect(logged).toContain('keeping previous')
    expect(logged).not.toContain(SECRET)
  })

  it('unchanged entries keep pool state across reload', async () => {
    const pool = async () =>
      (await (await fetch(`${url}/api/pool`)).json()).upstreams as Array<{
        name: string
        rateLimited: number
        disabled: number
      }>
    const { getUpstreamRegistry } = await import('../server/utils/upstream.js')
    const box = getUpstreamRegistry().get('box')
    const p = box?.getPool()
    const client = p?.getAvailableClient()
    if (!p || !client) throw new Error('no pool')
    p.handleRateLimitError(client, 60_000)
    await writeVault(
      {
        box: { provider: 'ollama', baseUrl: fakeUrl },
        extra: { provider: 'ollama', baseUrl: fakeUrl },
      },
      20_000,
    )
    expect((await pool()).find((u) => u.name === 'box')?.rateLimited).toBe(1)
    expect((await pool()).map((u) => u.name)).toContain('extra')
  })

  it('vault openrouter keys feed the default pool after env keys; env upstream wins', async () => {
    await stop()
    await writeVault({
      or: { provider: 'openrouter', apiKeys: ['v1', 'v2'] },
      box: { provider: 'ollama', baseUrl: 'http://vault.invalid' },
    })
    const handle = await startRouter({
      port: 0,
      host: '127.0.0.1',
      mock: false,
      vault: true,
      logDir: join(dir, 'logs'),
      apiKeys: ['e1'],
      upstreams: [{ name: 'box', kind: 'ollama', baseUrl: fakeUrl }],
    })
    stop = handle.close
    url = handle.url
    const body = await (await fetch(`${url}/api/pool`)).json()
    expect(body.totalKeys).toBe(3)
    expect(
      (
        await fetch(`${url}/api/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'box/m' }),
        })
      ).status,
    ).toBe(200)
  })

  it('missing vault => env-only behaviour', async () => {
    await stop()
    process.env.MT_VAULT = join(dir, 'absent.json')
    const handle = await startRouter({
      port: 0,
      host: '127.0.0.1',
      mock: false,
      vault: true,
      logDir: join(dir, 'logs'),
      apiKeys: [],
      upstreams: [],
    })
    stop = handle.close
    url = handle.url
    expect((await post('openrouter/free')).status).toBe(503)
    expect((await post('box/m')).status).toBe(503)
    process.env.MT_VAULT = vaultFile
  })
})
