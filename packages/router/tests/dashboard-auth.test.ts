import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type RouterHandle, startRouter } from '../server/standalone.js'

const ROUTER_TOKEN = 'dash-token-abc123'
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

/**
 * The dashboard is static (served without auth) while every panel calls an auth-guarded /api route,
 * so with MT_ROUTER_TOKEN set the UI must carry the bearer itself. Pins the server contract the
 * prompt relies on, plus the app.js rules: header-only, sessionStorage, no token in the URL.
 */
describe('dashboard behind router token auth', () => {
  let dir: string
  let handle: RouterHandle

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-router-dash-'))
    await mkdir(join(dir, 'logs'), { recursive: true })
    handle = await startRouter({
      port: 0,
      host: '127.0.0.1',
      mock: true,
      vault: false,
      token: ROUTER_TOKEN,
      logDir: join(dir, 'logs'),
      dashboardDir: PUBLIC_DIR,
      apiKeys: [],
    })
  })

  afterAll(async () => {
    await handle.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('serves the static dashboard without a token', async () => {
    const page = await fetch(`${handle.url}/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<div id="app"')
    const script = await fetch(`${handle.url}/app.js`)
    expect(script.status).toBe(200)
  })

  it('guards every panel endpoint and accepts the bearer', async () => {
    for (const path of ['/api/dashboard', '/api/pool', '/api/logs?limit=50']) {
      expect((await fetch(`${handle.url}${path}`)).status).toBe(401)
      const ok = await fetch(`${handle.url}${path}`, {
        headers: { authorization: `Bearer ${ROUTER_TOKEN}` },
      })
      expect(ok.status).toBe(200)
    }
  })

  it('app.js sends the bearer from sessionStorage-scoped state', async () => {
    const source = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8')
    expect(source).toContain('Authorization')
    expect(source).toContain('sessionStorage')
    expect(source).not.toContain('localStorage')
    expect(source).not.toContain('?token=')
    expect(source).not.toContain('#token')
  })

  it('app.js routes every /api call through the shared helper', async () => {
    const source = await readFile(join(PUBLIC_DIR, 'app.js'), 'utf-8')
    expect(source).not.toMatch(/fetch\(\s*['"`]\/api/)
    const helpers = source.match(/apiFetch\(/g) ?? []
    expect(helpers.length).toBeGreaterThanOrEqual(4)
  })
})
