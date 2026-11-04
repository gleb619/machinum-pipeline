import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type WorkerSpawnContext, runWorker } from '../../src/commands/worker.js'

const TOKEN = 'worker-e2e-token'
const cliEntry = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'index.ts')
const webuiServer = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'webui',
  'server',
)

interface BackendHandle {
  url: string
  close(): Promise<void>
}

interface WorkerRegistry {
  registerWorker(root: string, body?: Record<string, unknown>): Promise<{ id: string }>
  dispatchWorkerSignal(
    root: string,
    id: string,
    type: string,
    data?: Record<string, unknown>,
  ): Promise<{ id: number }>
  sweepWorkers(root: string, ttlMs?: number): Promise<Array<{ id: string; status: string }>>
  resetWorkerRegistry(): void
}

let startBackend: (options: Record<string, unknown>) => Promise<BackendHandle>
let registry: WorkerRegistry

async function loadWebui(): Promise<void> {
  if (registry !== undefined) return
  const standalone = (await import(/* @vite-ignore */ join(webuiServer, 'standalone.ts'))) as {
    startBackend: typeof startBackend
  }
  registry = (await import(
    /* @vite-ignore */ join(webuiServer, 'utils', 'worker-registry.ts')
  )) as WorkerRegistry
  startBackend = standalone.startBackend
}
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

const FIXTURE = `const source = {
  uri: 'fixture://one',
  lifestyle: 'resumable',
  async *start() {
    yield { item: { n: 1 }, meta: {} }
  },
}
const echo = {
  name: 'worker-fixture-tool',
  version: '1.0.0',
  async invoke(ex) {
    return ex
  },
}
const target = {
  uri: 'fixture://out',
  async open() {},
  async write() {},
  async close() {},
}
export default {
  id: 'worker-fixture',
  retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
  onError: 'fail-run',
  steps: [
    { type: 'source', config: { uri: source.uri, instance: source } },
    { type: 'tool', config: { name: echo.name, version: echo.version, tool: echo } },
    { type: 'target', config: { uri: target.uri, instance: target } },
  ],
}
`

const CRASH_FIXTURE = `const source = {
  uri: 'fixture://one',
  lifestyle: 'resumable',
  async *start() {
    yield { item: { n: 1 }, meta: {} }
  },
}
const boom = {
  name: 'worker-crash-tool',
  version: '1.0.0',
  async invoke() {
    throw new Error('intentional child crash')
  },
}
const target = {
  uri: 'fixture://out',
  async open() {},
  async write() {},
  async close() {},
}
export default {
  id: 'worker-crash',
  retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
  onError: 'fail-run',
  steps: [
    { type: 'source', config: { uri: source.uri, instance: source } },
    { type: 'tool', config: { name: boom.name, version: boom.version, tool: boom } },
    { type: 'target', config: { uri: target.uri, instance: target } },
  ],
}
`

const silentLogger = {
  setRunId: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  flush: async () => undefined,
}

function spawnRealChild(context: WorkerSpawnContext) {
  const forwarded = context.spec.args[0]?.startsWith('/')
    ? context.spec.args.slice(1)
    : context.spec.args
  return spawn(context.spec.command, ['--import', tsxLoader, cliEntry, ...forwarded], {
    cwd: context.spec.cwd,
    env: { ...context.spec.env, MT_WORKER_MAIN_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function writeProject(root: string): Promise<void> {
  await mkdir(join(root, 'pipelines'), { recursive: true })
  await writeFile(join(root, 'mt.json'), JSON.stringify({ project: { name: 'worker-main' } }))
  await writeFile(join(root, 'pipelines', 'echo.ts'), FIXTURE)
  await writeFile(join(root, 'pipelines', 'crash.ts'), CRASH_FIXTURE)
}

async function listWorkers(handle: BackendHandle): Promise<Array<{ id: string }>> {
  const response = await fetch(`${handle.url}/api/workers`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  return (await response.json()) as Array<{ id: string }>
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function startWorkerRun(
  handle: BackendHandle,
  workerId: string,
  pipeline: string,
): Promise<string> {
  const response = await fetch(`${handle.url}/api/runs/start`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ worker: workerId, pipeline }),
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { runId: string }
  return body.runId
}

async function runState(handle: BackendHandle, runId: string): Promise<string | undefined> {
  const response = await fetch(`${handle.url}/api/runs/${runId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  if (!response.ok) return undefined
  return ((await response.json()) as { state: string }).state
}

describe('mt worker e2e (T205)', () => {
  let mainRoot: string
  let workerRoot: string
  let handle: BackendHandle

  beforeAll(async () => {
    await loadWebui()
    mainRoot = await mkdtemp(join(tmpdir(), 'mt-worker-main-'))
    workerRoot = await mkdtemp(join(tmpdir(), 'mt-worker-node-'))
    await writeProject(mainRoot)
    registry.resetWorkerRegistry()
    handle = await startBackend({
      port: 0,
      host: '127.0.0.1',
      router: false,
      projectRoot: mainRoot,
      token: TOKEN,
    })
  })

  afterAll(async () => {
    await handle.close()
    registry.resetWorkerRegistry()
    await rm(mainRoot, { recursive: true, force: true })
    await rm(workerRoot, { recursive: true, force: true })
  })

  it('registers, mirrors, runs a child, forwards events, survives a crash and drains', async () => {
    const workerRun = runWorker({
      mainUrl: handle.url,
      token: TOKEN,
      name: 'e2e-worker',
      tags: ['e2e'],
      maxRuns: 1,
      projectRoot: workerRoot,
      logger: silentLogger,
      spawnChild: spawnRealChild,
      heartbeatIntervalMs: 60_000,
      projectPollIntervalMs: 60_000,
    })

    const workers = await waitFor('worker registration', async () => {
      const list = await listWorkers(handle)
      return list.length > 0 ? list : undefined
    })
    const workerId = workers[0]?.id as string

    const okRun = await startWorkerRun(handle, workerId, 'pipelines/echo.ts')
    await waitFor('the worker run to finish on main', async () =>
      (await runState(handle, okRun)) === 'done' ? true : undefined,
    )
    const events = await readFile(join(mainRoot, '.mt', 'runs', okRun, 'events.jsonl'), 'utf8')
    expect(events).toContain('"type":"started"')
    expect(events).toContain('"type":"done"')

    const crashRun = await startWorkerRun(handle, workerId, 'pipelines/crash.ts')
    await waitFor('the crashed child to be reported failed', async () =>
      (await runState(handle, crashRun)) === 'failed' ? true : undefined,
    )

    await registry.dispatchWorkerSignal(mainRoot, workerId, 'drain')
    await expect(workerRun).resolves.toBe(0)
  }, 30_000)
})

describe('lost worker pauses its runs (T205)', () => {
  let root: string
  let handle: BackendHandle

  beforeAll(async () => {
    await loadWebui()
    root = await mkdtemp(join(tmpdir(), 'mt-worker-lost-'))
    await writeProject(root)
    registry.resetWorkerRegistry()
    process.env.MT_WORKER_TTL_MS = '40'
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
    registry.resetWorkerRegistry()
    Reflect.deleteProperty(process.env, 'MT_WORKER_TTL_MS')
    await rm(root, { recursive: true, force: true })
  })

  it('marks the run paused, not failed, after the heartbeat TTL', async () => {
    const worker = await registry.registerWorker(root, { name: 'vanishing' })
    const runId = await startWorkerRun(handle, worker.id, 'pipelines/echo.ts')
    await new Promise((resolve) => setTimeout(resolve, 60))
    const swept = await registry.sweepWorkers(root, 40)
    expect(swept.find((entry) => entry.id === worker.id)?.status).toBe('lost')
    expect(await runState(handle, runId)).toBe('paused')
    expect(await readFile(join(root, '.mt', 'runs', runId, 'events.jsonl'), 'utf8')).toContain(
      '"type":"paused"',
    )
  })
})
