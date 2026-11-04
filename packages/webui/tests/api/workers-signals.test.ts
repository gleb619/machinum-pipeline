import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BackendHandle, startBackend } from '../../server/standalone.js'
import {
  dispatchWorkerSignal,
  registerWorker,
  resetWorkerRegistry,
  workerSignalsAfter,
} from '../../server/utils/worker-registry.js'

const TOKEN = 'worker-token'

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs = 2_000,
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    if (text.includes(needle)) return text
  }
  throw new Error(`Timed out waiting for ${needle}; got: ${text}`)
}

describe('worker API (T205)', () => {
  let root: string
  let handle: BackendHandle

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mt-workers-api-'))
    await mkdir(join(root, 'pipelines'), { recursive: true })
    await writeFile(
      join(root, 'pipelines', 'demo.ts'),
      'export default { id: "demo", steps: [] }\n',
    )
    resetWorkerRegistry()
    process.env.MT_WORKER_SIGNAL_HEARTBEAT_MS = '20'
    handle = await startBackend({
      port: 0,
      host: '127.0.0.1',
      router: false,
      projectRoot: root,
      token: TOKEN,
    })
  })

  afterAll(async () => {
    await handle.close()
    resetWorkerRegistry()
    Reflect.deleteProperty(process.env, 'MT_WORKER_SIGNAL_HEARTBEAT_MS')
    await rm(root, { recursive: true, force: true })
  })

  const auth = { Authorization: `Bearer ${TOKEN}` }

  it('requires the serve bearer token on worker routes', async () => {
    expect((await fetch(`${handle.url}/api/workers`)).status).toBe(401)
    expect((await fetch(`${handle.url}/api/workers`, { headers: auth })).status).toBe(200)
  })

  it('registers, lists and heartbeats a worker', async () => {
    const registered = await fetch(`${handle.url}/api/workers`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'gpu-box', tags: ['gpu', 'docker'] }),
    })
    expect(registered.status).toBe(200)
    const worker = (await registered.json()) as { id: string; name: string; tags: string[] }
    expect(worker).toMatchObject({ name: 'gpu-box', tags: ['gpu', 'docker'] })

    const list = (await (
      await fetch(`${handle.url}/api/workers`, { headers: auth })
    ).json()) as Array<{ id: string }>
    expect(list.some((entry) => entry.id === worker.id)).toBe(true)

    const beat = await fetch(`${handle.url}/api/workers/${worker.id}/heartbeat`, {
      method: 'POST',
      headers: auth,
    })
    expect(beat.status).toBe(200)
    expect((await beat.json()) as { status: string }).toMatchObject({ status: 'online' })
  })

  it('streams signals over SSE and replays after Last-Event-ID', async () => {
    const worker = await registerWorker(root, { name: 'sse' })
    const first = await dispatchWorkerSignal(root, worker.id, 'project-changed')
    const second = await dispatchWorkerSignal(root, worker.id, 'run', { runId: 'run-1' })

    const response = await fetch(`${handle.url}/api/workers/${worker.id}/signals`, {
      headers: { ...auth, 'Last-Event-ID': String(first.id) },
    })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const text = await readUntil(reader as ReadableStreamDefaultReader<Uint8Array>, 'run-1')
    expect(text).toContain(`id: ${second.id}`)
    expect(text).toContain('event: run')
    await reader?.cancel()
  })

  it('sends a heartbeat comment on an idle SSE connection', async () => {
    const worker = await registerWorker(root, { name: 'idle' })
    const response = await fetch(`${handle.url}/api/workers/${worker.id}/signals`, {
      headers: auth,
    })
    const reader = response.body?.getReader()
    const text = await readUntil(reader as ReadableStreamDefaultReader<Uint8Array>, ': heartbeat')
    expect(text).toContain(': heartbeat')
    await reader?.cancel()
  })

  it('supports the long-poll fallback', async () => {
    const worker = await registerWorker(root, { name: 'poll' })
    const signal = await dispatchWorkerSignal(root, worker.id, 'drain')
    const response = await fetch(`${handle.url}/api/workers/${worker.id}/signals?wait=1`, {
      headers: { ...auth, 'Last-Event-ID': '0' },
    })
    expect(response.status).toBe(200)
    expect((await response.json()) as { signals: Array<{ id: number }> }).toMatchObject({
      signals: [{ id: signal.id, type: 'drain' }],
    })
  })

  it('routes a start request to a worker matching tags and signals it', async () => {
    const worker = await registerWorker(root, {
      name: 'tagged',
      tags: ['gpu', 'docker', 'tagged-only'],
    })
    const response = await fetch(`${handle.url}/api/runs/start`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['tagged-only'], pipeline: 'pipelines/demo.ts' }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { runId: string; workerId: string }
    expect(body.workerId).toBe(worker.id)
    const signals = await workerSignalsAfter(root, worker.id, 0)
    expect(signals.at(-1)).toMatchObject({
      type: 'run',
      data: { runId: body.runId, pipeline: 'pipelines/demo.ts' },
    })
  })

  it('rejects a start request when no worker carries the tags', async () => {
    const response = await fetch(`${handle.url}/api/runs/start`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['missing'], pipeline: 'pipelines/demo.ts' }),
    })
    expect(response.status).toBe(409)
  })

  it('ingests NDJSON run events and mirrors the terminal state', async () => {
    const worker = await registerWorker(root, { name: 'ingest' })
    const started = await fetch(`${handle.url}/api/runs/start`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker: worker.id, pipeline: 'pipelines/demo.ts' }),
    })
    const { runId } = (await started.json()) as { runId: string }

    const invalid = await fetch(`${handle.url}/api/runs/${runId}/events`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/x-ndjson' },
      body: 'not json\n',
    })
    expect(invalid.status).toBe(400)

    const lines = [
      { type: 'started', ts: new Date().toISOString(), runId },
      { type: 'done', ts: new Date().toISOString(), runId },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')
    const accepted = await fetch(`${handle.url}/api/runs/${runId}/events`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/x-ndjson' },
      body: `${lines}\n`,
    })
    expect(accepted.status).toBe(200)
    expect((await accepted.json()) as { written: number }).toMatchObject({ written: 2 })

    const detail = (await (
      await fetch(`${handle.url}/api/runs/${runId}`, { headers: auth })
    ).json()) as { state: string }
    expect(detail.state).toBe('done')
    expect(await readFile(join(root, '.mt', 'runs', runId, 'events.jsonl'), 'utf8')).toContain(
      '"type":"done"',
    )
  })
})
