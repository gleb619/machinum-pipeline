import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WORKER_SIGNAL_RING,
  attachWorkerRun,
  dispatchWorkerSignal,
  getWorker,
  heartbeatWorker,
  listWorkers,
  markWorkerLost,
  registerWorker,
  resetWorkerRegistry,
  sweepWorkers,
  waitForWorkerSignal,
  workerSignalsAfter,
} from '../../server/utils/worker-registry.js'

describe('worker registry (T205)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mt-worker-registry-'))
    resetWorkerRegistry()
    Reflect.deleteProperty(process.env, 'MT_WORKER_TTL_MS')
  })

  afterEach(async () => {
    resetWorkerRegistry()
    await rm(root, { recursive: true, force: true })
  })

  it('registers a worker, persists it atomically and lists it', async () => {
    const worker = await registerWorker(root, {
      name: 'gpu-box',
      tags: ['gpu', 'docker'],
      mtVersion: '0.1.0',
    })
    expect(worker.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(worker.status).toBe('online')

    const persisted = JSON.parse(
      await readFile(join(root, '.mt', 'workers', `${worker.id}.json`), 'utf8'),
    ) as { name: string; tags: string[]; runs: string[] }
    expect(persisted).toMatchObject({ name: 'gpu-box', tags: ['gpu', 'docker'], runs: [] })

    resetWorkerRegistry()
    const listed = await listWorkers(root)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(worker.id)
  })

  it('updates lastSeen on heartbeat and reports a worker as lost past the TTL', async () => {
    const worker = await registerWorker(root, { tags: ['gpu'] })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const beaten = await heartbeatWorker(root, worker.id)
    expect(Date.parse(beaten?.lastSeen ?? '')).toBeGreaterThan(Date.parse(worker.lastSeen))

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await sweepWorkers(root, 1))[0]?.status).toBe('lost')
  })

  it('pauses runs of a lost worker without failing them', async () => {
    const worker = await registerWorker(root, {})
    const runId = 'run-lost'
    const runDir = join(root, '.mt', 'runs', runId)
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'state.json'),
      JSON.stringify({
        runId,
        pipelineId: 'demo',
        state: 'running',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        checkpoint: { stepId: 'root', state: 'in-progress', children: [] },
        contextRef: `runs/${runId}/context.json`,
      }),
    )
    await attachWorkerRun(root, worker.id, runId)
    await markWorkerLost(root, worker.id)

    const state = JSON.parse(await readFile(join(runDir, 'state.json'), 'utf8')) as {
      state: string
    }
    expect(state.state).toBe('paused')
    const events = await readFile(join(runDir, 'events.jsonl'), 'utf8')
    expect(events).toContain('"type":"paused"')
    expect((await getWorker(root, worker.id))?.status).toBe('lost')
  })

  it('replays signals from the ring after Last-Event-ID and caps the ring', async () => {
    const worker = await registerWorker(root, {})
    for (let index = 0; index < WORKER_SIGNAL_RING + 3; index++) {
      await dispatchWorkerSignal(root, worker.id, 'project-changed')
    }
    const all = await workerSignalsAfter(root, worker.id, 0)
    expect(all).toHaveLength(WORKER_SIGNAL_RING)
    expect(all[0]?.id).toBe(4)

    const replay = await workerSignalsAfter(root, worker.id, 100)
    expect(replay.every((signal) => signal.id > 100)).toBe(true)
    expect(replay.at(-1)?.id).toBe(WORKER_SIGNAL_RING + 3)
  })

  it('continues signal ids after an in-memory registry reset (main restart)', async () => {
    const worker = await registerWorker(root, {})
    const first = await dispatchWorkerSignal(root, worker.id, 'project-changed')
    resetWorkerRegistry()
    const next = await dispatchWorkerSignal(root, worker.id, 'drain')
    expect(next.id).toBe(first.id + 1)
  })

  it('waits for the next signal and times out cleanly', async () => {
    const worker = await registerWorker(root, {})
    const pending = waitForWorkerSignal(root, worker.id, 0, 1_000)
    const sent = await dispatchWorkerSignal(root, worker.id, 'run', { runId: 'r1' })
    await expect(pending).resolves.toMatchObject({ id: sent.id, type: 'run' })
    await expect(waitForWorkerSignal(root, worker.id, sent.id, 10)).resolves.toBeUndefined()
  })
})
