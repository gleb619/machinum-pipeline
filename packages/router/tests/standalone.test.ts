import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type RouterHandle, startRouter } from '../server/standalone.js'

/**
 * The standalone runtime must serve every route the Nitro dev server does, in mock mode and without
 * touching the network — this is the path `mt router` (and the Bun binary) takes.
 */
describe('standalone router (h3 + node:http, no Nitro, mock mode)', () => {
  let dir: string
  let handle: RouterHandle

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-router-'))
    await mkdir(join(dir, 'dashboard'), { recursive: true })
    await writeFile(join(dir, 'dashboard', 'index.html'), '<div id="app">router</div>')
    await writeFile(join(dir, 'dashboard', 'app.js'), 'console.log("dash")')
    handle = await startRouter({
      port: 0,
      host: '127.0.0.1',
      mock: true,
      logDir: join(dir, 'logs'),
      dashboardDir: join(dir, 'dashboard'),
      // Empty on purpose: the pool must reflect the passed config, not whatever key the dev machine
      // happens to export.
      apiKeys: [],
    })
  })

  afterAll(async () => {
    await handle.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('reports mock mode on /api/health', async () => {
    const body = (await (await fetch(`${handle.url}/api/health`)).json()) as {
      status: string
      mockMode: boolean
    }
    expect(body.status).toBe('ok')
    expect(body.mockMode).toBe(true)
  })

  it('answers /api/chat/completions from the mock, without an API key', async () => {
    const res = await fetch(`${handle.url}/api/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-ratelimit-remaining')).not.toBeNull()
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toBe('Mock response from Mt Router')
  })

  it('translates through the mock, single and batch', async () => {
    const one = (await (
      await fetch(`${handle.url}/api/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello', targetLang: 'fr' }),
      })
    ).json()) as { translatedText: string }
    expect(one.translatedText).toBe('[MOCK] hello')

    const batch = (await (
      await fetch(`${handle.url}/api/translate?batch=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: ['a', 'b'], targetLang: 'de' }),
      })
    ).json()) as { results: Array<{ translatedText: string }> }
    expect(batch.results.map((r) => r.translatedText)).toEqual(['[MOCK] a', '[MOCK] b'])
  })

  it('serves the dashboard API, pool and log endpoints', async () => {
    const dash = (await (await fetch(`${handle.url}/api/dashboard`)).json()) as {
      budgetLimit: number
      today: { calls: number }
    }
    expect(dash.today.calls).toBe(0)
    expect(dash.budgetLimit).toBeGreaterThan(0)

    const pool = (await (await fetch(`${handle.url}/api/pool`)).json()) as Record<string, unknown>
    expect(pool).toMatchObject({ mockMode: true, totalKeys: 0, activeKeys: 0 })

    const logs = (await (await fetch(`${handle.url}/api/logs`)).json()) as { entries: unknown[] }
    expect(logs.entries).toEqual([])

    const translateHealth = (await (await fetch(`${handle.url}/api/translate/health`)).json()) as {
      availableClients: number
      totalClients: number
    }
    expect(translateHealth).toEqual({ availableClients: 0, totalClients: 0 })

    const config = (await (await fetch(`${handle.url}/api/translate/config`)).json()) as {
      defaultModel: string
    }
    expect(config.defaultModel).toBe('openai/gpt-4o-mini')
  })

  it('serves dashboard assets and 404s the rest', async () => {
    expect(await (await fetch(`${handle.url}/`)).text()).toContain('id="app"')
    expect(await (await fetch(`${handle.url}/app.js`)).text()).toContain('console.log')
    expect((await fetch(`${handle.url}/missing.html`)).status).toBe(404)
    expect((await fetch(`${handle.url}/api/nope`)).status).toBe(404)
  })
})

describe('standalone router config handling', () => {
  it('serves embedded assets when no dashboard directory is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-router-embedded-'))
    const asset = join(dir, 'index.html')
    await writeFile(asset, '<html>embedded</html>')
    const handle = await startRouter({
      port: 0,
      host: '127.0.0.1',
      mock: true,
      logDir: join(dir, 'logs'),
      dashboard: { '/index.html': asset },
    })
    try {
      expect(await (await fetch(`${handle.url}/`)).text()).toContain('embedded')
    } finally {
      await handle.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the daily budget out of the mock path and reflects overrides', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-router-budget-'))
    const handle = await startRouter({
      port: 0,
      host: '127.0.0.1',
      mock: true,
      logDir: join(dir, 'logs'),
      dailyBudget: 2.5,
    })
    try {
      const dash = (await (await fetch(`${handle.url}/api/dashboard`)).json()) as {
        budgetLimit: number
        budgetRemaining: number
      }
      expect(dash.budgetLimit).toBe(2.5)
      expect(dash.budgetRemaining).toBe(2.5)
    } finally {
      await handle.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
