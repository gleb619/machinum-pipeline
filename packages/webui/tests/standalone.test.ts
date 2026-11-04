import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ParsedUri, SourceContext } from '@mt/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpSource } from '../../waypoint/src/http-server.js'
import { type BackendHandle, startBackend } from '../server/standalone.js'

describe('standalone backend (h3 + node:http, no Nitro)', () => {
  let dir: string
  let cwd: string
  let handle: BackendHandle
  let previousToken: string | undefined

  beforeAll(async () => {
    previousToken = process.env.MT_SERVE_TOKEN
    Reflect.deleteProperty(process.env, 'MT_SERVE_TOKEN')
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
    if (previousToken === undefined) Reflect.deleteProperty(process.env, 'MT_SERVE_TOKEN')
    else process.env.MT_SERVE_TOKEN = previousToken
    await rm(dir, { recursive: true, force: true })
  })

  it('serves /api/health with version, sync protocol and capabilities', async () => {
    const res = await fetch(`${handle.url}/api/health`)
    const body = (await res.json()) as {
      status: string
      version: string
      syncVersion: number
      capabilities: Record<string, boolean>
    }
    expect(body.status).toBe('ok')
    expect(body.version).toBe('0.1.0')
    expect(body.syncVersion).toBe(1)
    expect(Object.keys(body.capabilities).sort()).toEqual([
      'chrome',
      'docker',
      'ollama',
      'playwright',
    ])
    expect(Object.values(body.capabilities).every((value) => typeof value === 'boolean')).toBe(true)
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

  it('shares its port with an hs:// source without losing /api/*', async () => {
    const uri: ParsedUri = {
      raw: `hs://127.0.0.1:${handle.port}/ingest`,
      scheme: 'hs',
      host: `127.0.0.1:${handle.port}`,
      path: '/ingest',
      query: { port: String(handle.port) },
      fragment: '',
    }
    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    }
    const ctx = {
      run: { runId: 'shared-run', global: { env: {} }, logger },
    } as unknown as SourceContext
    const source = createHttpSource<{ id: number }>(uri)
    const iterator = source.start(ctx)[Symbol.asyncIterator]()
    const next = iterator.next()

    await until('the hs:// source to mount its routes', async () => {
      const health = await fetch(`${handle.url}/ingest/health`).catch(() => null)
      return health?.status === 200
    })

    expect((await fetch(`${handle.url}/api/health`)).status).toBe(200)
    const posted = await fetch(`${handle.url}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 9 }),
    })
    expect(posted.status).toBe(200)
    expect((await next).value).toMatchObject({ item: { id: 9 } })

    await iterator.return?.()
  })
})

describe('serve auth token (T202)', () => {
  const TOKEN = 'serve-token-secret'
  let dir: string
  let cwd: string
  let handle: BackendHandle
  let previousToken: string | undefined

  beforeAll(async () => {
    previousToken = process.env.MT_SERVE_TOKEN
    Reflect.deleteProperty(process.env, 'MT_SERVE_TOKEN')
    cwd = process.cwd()
    dir = await mkdtemp(join(tmpdir(), 'mt-backend-auth-'))
    await mkdir(join(dir, 'ui'), { recursive: true })
    await writeFile(join(dir, 'ui', 'index.html'), '<div id="app"></div>')
    process.chdir(dir)
    handle = await startBackend({
      port: 0,
      host: '127.0.0.1',
      uiDir: join(dir, 'ui'),
      token: TOKEN,
    })
  })

  afterAll(async () => {
    await handle.close()
    process.chdir(cwd)
    if (previousToken === undefined) Reflect.deleteProperty(process.env, 'MT_SERVE_TOKEN')
    else process.env.MT_SERVE_TOKEN = previousToken
    await rm(dir, { recursive: true, force: true })
  })

  it('answers 401 without a header and with a wrong token', async () => {
    const missing = await fetch(`${handle.url}/api/runs`)
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toBe('Bearer')
    expect(await missing.json()).toEqual({ error: 'Unauthorized' })

    const wrong = await fetch(`${handle.url}/api/runs`, {
      headers: { authorization: 'Bearer wrong-token-with-a-different-length' },
    })
    expect(wrong.status).toBe(401)
  })

  it('accepts the right bearer token', async () => {
    const res = await fetch(`${handle.url}/api/runs`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('keeps GET /api/health open but minimal without auth', async () => {
    const open = await fetch(`${handle.url}/api/health`)
    expect(open.status).toBe(200)
    expect(await open.json()).toEqual({ status: 'ok' })

    const authed = await fetch(`${handle.url}/api/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(authed.status).toBe(200)
    expect(await authed.json()).toMatchObject({ status: 'ok', version: '0.1.0', syncVersion: 1 })
    expect(await (await fetch(`${handle.url}/`)).text()).toContain('id="app"')
  })
})

describe('serve bind guard (T202)', () => {
  let dir: string
  let cwd: string
  let previousToken: string | undefined

  beforeAll(async () => {
    previousToken = process.env.MT_SERVE_TOKEN
    Reflect.deleteProperty(process.env, 'MT_SERVE_TOKEN')
    cwd = process.cwd()
    dir = await mkdtemp(join(tmpdir(), 'mt-backend-guard-'))
    process.chdir(dir)
  })

  afterAll(async () => {
    process.chdir(cwd)
    if (previousToken === undefined) Reflect.deleteProperty(process.env, 'MT_SERVE_TOKEN')
    else process.env.MT_SERVE_TOKEN = previousToken
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses a non-loopback bind without a token', async () => {
    await expect(startBackend({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/MT_SERVE_TOKEN/)
  })
})

const GATE_KEY = '__MT_LIVE_RUN_RELEASE__'

function gate(): (() => void) | undefined {
  return (globalThis as Record<string, unknown>)[GATE_KEY] as (() => void) | undefined
}

async function until(
  label: string,
  cond: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('pause/resume of a live run (T084)', () => {
  let dir: string
  let previousCwd: string
  let handle: BackendHandle

  beforeAll(async () => {
    // Under the vitest root so the runtime-written pipeline module stays resolvable
    dir = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), 'live-run.ignore.'))
    await writeFile(
      join(dir, 'pipeline.mjs'),
      `export default {
  id: 'live-run-fixture',
  retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
  onError: 'fail-run',
  steps: [
    {
      type: 'tap',
      config: {
        fn: async () => {
          await new Promise((resolve) => {
            globalThis['${GATE_KEY}'] = resolve
          })
        },
      },
    },
  ],
}
`,
    )
    previousCwd = process.cwd()
    process.chdir(dir)
    handle = await startBackend({ port: 0, host: '127.0.0.1' })
  })

  afterAll(async () => {
    gate()?.()
    delete (globalThis as Record<string, unknown>)[GATE_KEY]
    await handle.close()
    process.chdir(previousCwd)
    await rm(dir, { recursive: true, force: true })
  })

  async function post(path: string): Promise<Response> {
    return fetch(`${handle.url}${path}`, { method: 'POST' })
  }

  async function runState(runId: string): Promise<string> {
    const body = (await (await fetch(`${handle.url}/api/runs/${runId}`)).json()) as {
      state: string
    }
    return body.state
  }

  it('pause → resume a run started through POST /api/runs/start, then drops it when done', async () => {
    const started = await fetch(`${handle.url}/api/runs/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pipeline: 'pipeline.mjs' }),
    })
    expect(started.status).toBe(200)
    const { runId } = (await started.json()) as { runId: string }
    expect(runId).toBeTruthy()

    await until('the run to park on its tap step', () => gate() !== undefined)

    const paused = await post(`/api/runs/${runId}/pause`)
    expect(paused.status).toBe(200)
    expect(await paused.json()).toEqual({ runId, state: 'paused' })
    await until('paused state to be persisted', () => runState(runId).then((s) => s === 'paused'))

    const resumed = await post(`/api/runs/${runId}/resume`)
    expect(resumed.status).toBe(200)
    expect(await resumed.json()).toEqual({ runId, state: 'running' })
    await until('running state to be persisted', () => runState(runId).then((s) => s === 'running'))

    gate()?.()
    await until('the finished runner to unregister', async () => {
      const res = await post(`/api/runs/${runId}/pause`)
      return res.status === 404
    })
    expect(await runState(runId)).toBe('done')
  })

  it('writes events.jsonl for a real run, so SSE replay resolves', async () => {
    // Drop the previous run's resolver: `gate()` must only flip once *this* run parks.
    delete (globalThis as Record<string, unknown>)[GATE_KEY]

    const started = await fetch(`${handle.url}/api/runs/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pipeline: 'pipeline.mjs' }),
    })
    const { runId } = (await started.json()) as { runId: string }

    await until('the run to park on its tap step', () => gate() !== undefined)
    const paused = await post(`/api/runs/${runId}/pause`)
    expect(paused.status).toBe(200)
    await until('paused state to be persisted', () => runState(runId).then((s) => s === 'paused'))
    expect((await post(`/api/runs/${runId}/resume`)).status).toBe(200)
    gate()?.()
    // Poll the persisted state, not POST /pause: the pause probe would itself pause a run
    // still inside its tail window, which is exactly the race this run must not trip on.
    await until('the run to finish', () => runState(runId).then((s) => s === 'done'))

    const raw = await readFile(join(dir, '.mt', 'runs', runId, 'events.jsonl'), 'utf-8')
    const types = raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => (JSON.parse(line) as { type: string }).type)
    expect(types).toEqual(['started', 'paused', 'resumed', 'step-done', 'done'])

    const res = await fetch(`${handle.url}/api/runs/${runId}/events`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(await res.text()).toContain('event: started')
  })

  it('keeps an unknown runId a 404 on both pause and resume', async () => {
    expect((await post('/api/runs/no-such-run/pause')).status).toBe(404)
    expect((await post('/api/runs/no-such-run/resume')).status).toBe(404)
  })
})
