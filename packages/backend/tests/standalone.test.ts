import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BackendHandle, startBackend } from '../server/standalone.js'

describe('standalone backend (h3 + node:http, no Nitro)', () => {
  let dir: string
  let cwd: string
  let handle: BackendHandle

  beforeAll(async () => {
    cwd = process.cwd()
    dir = await mkdtemp(join(tmpdir(), 'mt-backend-'))
    await mkdir(join(dir, '.mt', 'runs', 'r1'), { recursive: true })
    await writeFile(join(dir, '.mt', 'runs', 'r1', 'state.json'), '{"state":"running"}')
    await writeFile(join(dir, '.mt', 'runs', 'r1', 'events.jsonl'), '{"type":"started"}\n')
    await mkdir(join(dir, 'ui'), { recursive: true })
    await writeFile(join(dir, 'ui', 'index.html'), '<div id="app"></div>')
    process.chdir(dir)
    handle = await startBackend({ port: 0, host: '127.0.0.1', uiDir: join(dir, 'ui') })
  })

  afterAll(async () => {
    await handle.close()
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  })

  it('serves /api/health', async () => {
    const res = await fetch(`${handle.url}/api/health`)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('lists runs and run detail', async () => {
    const list = (await (await fetch(`${handle.url}/api/runs`)).json()) as { id: string }[]
    expect(list.map((r) => r.id)).toEqual(['r1'])
    const one = (await (await fetch(`${handle.url}/api/runs/r1`)).json()) as { state: string }
    expect(one.state).toBe('running')
    expect((await fetch(`${handle.url}/api/runs/nope`)).status).toBe(404)
  })

  it('replays run events as SSE', async () => {
    const res = await fetch(`${handle.url}/api/runs/r1/events`)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(await res.text()).toContain('event: started')
  })

  it('serves the UI with SPA fallback and 404 for unknown api paths', async () => {
    expect(await (await fetch(`${handle.url}/`)).text()).toContain('id="app"')
    expect(await (await fetch(`${handle.url}/some/route`)).text()).toContain('id="app"')
    expect((await fetch(`${handle.url}/api/nope`)).status).toBe(404)
  })
})
