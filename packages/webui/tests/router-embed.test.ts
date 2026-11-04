import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BackendHandle, startBackend } from '../server/standalone.js'

const ROUTER_TOKEN = 'embed-router-token'

describe('embedded router (T197)', () => {
  const previous = {
    MT_HOME: process.env.MT_HOME,
    MT_ROUTER_MOCK: process.env.MT_ROUTER_MOCK,
    MT_ROUTER_TOKEN: process.env.MT_ROUTER_TOKEN,
    MT_ROUTER_VAULT: process.env.MT_ROUTER_VAULT,
    MT_VAULT: process.env.MT_VAULT,
  }
  let dir: string
  let handle: BackendHandle
  let withoutRouter: BackendHandle

  const auth = { authorization: `Bearer ${ROUTER_TOKEN}` }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mt-webui-router-'))
    process.env.MT_HOME = join(dir, 'home')
    process.env.MT_ROUTER_MOCK = 'true'
    process.env.MT_ROUTER_TOKEN = ROUTER_TOKEN
    process.env.MT_ROUTER_VAULT = 'false'
    process.env.MT_VAULT = join(dir, 'no-vault.json')
    handle = await startBackend({ port: 0, host: '127.0.0.1' })
    withoutRouter = await startBackend({ port: 0, host: '127.0.0.1', router: false })
  })

  afterAll(async () => {
    await handle.close()
    await withoutRouter.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('serves admin and router APIs on the same port', async () => {
    expect((await fetch(`${handle.url}/api/runs`)).status).toBe(200)
    expect((await fetch(`${handle.url}/api/pool`)).status).toBe(401)
    expect((await fetch(`${handle.url}/api/pool`, { headers: auth })).status).toBe(200)

    const res = await fetch(`${handle.url}/api/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toBe('Mock response from Mt Router')
  })

  it('keeps /api/health owned by the admin API', async () => {
    const health = (await (await fetch(`${handle.url}/api/health`)).json()) as {
      status: string
      version: string
      syncVersion: number
    }
    expect(health).toMatchObject({ status: 'ok', version: '0.1.0', syncVersion: 1 })

    const routerHealth = (await (await fetch(`${handle.url}/api/router/health`)).json()) as {
      status: string
      mockMode: boolean
    }
    expect(routerHealth.status).toBe('ok')
    expect(routerHealth.mockMode).toBe(true)
  })

  it('requires the router token only on router routes', async () => {
    for (const path of ['/api/dashboard', '/api/pool', '/api/logs']) {
      expect((await fetch(`${handle.url}${path}`)).status).toBe(401)
      expect((await fetch(`${handle.url}${path}`, { headers: auth })).status).toBe(200)
    }
    expect((await fetch(`${handle.url}/api/runs`)).status).toBe(200)
    expect((await fetch(`${handle.url}/api/pipelines`)).status).toBe(200)
  })

  it('--no-router leaves admin routes and health intact', async () => {
    expect(await (await fetch(`${withoutRouter.url}/api/health`)).json()).toMatchObject({
      status: 'ok',
      version: '0.1.0',
      syncVersion: 1,
    })
    expect((await fetch(`${withoutRouter.url}/api/dashboard`)).status).toBe(404)
    expect((await fetch(`${withoutRouter.url}/api/router/health`)).status).toBe(404)
    expect((await fetch(`${withoutRouter.url}/api/runs`)).status).toBe(200)
  })
})
