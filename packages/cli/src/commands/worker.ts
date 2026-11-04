import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { MT_VERSION, annotate, createConsoleLogger, matchesAnyGlob, useCase } from '@mt/core'
import type { Logger } from '@mt/core'
import { resolveRemoteToken } from '../utils/remote-client.js'
import type { RemoteRunLogger } from '../utils/remote-run.js'
import {
  type WorkerRegistrationBody,
  getMainRunState,
  heartbeatWorkerWithMain,
  postRunEvents,
  pullWorkerProject,
  registerWorkerWithMain,
  workerMirrorPath,
} from '../utils/worker-client.js'

const DEFAULT_ALLOW_PIPELINES = ['pipelines/**']
const DEFAULT_MAX_RUNS = 1
const DEFAULT_RECONNECT_MS = 500
const MAX_RECONNECT_MS = 10_000
const DEFAULT_HEARTBEAT_MS = 20_000
const DEFAULT_PROJECT_POLL_MS = 60_000

export interface WorkerCommandOptions {
  mainUrl?: string
  tokenRef?: string
  name?: string
  tags: string[]
  maxRuns: number
  allowPipelines: string[]
}

export interface WorkerSignal {
  id: number
  type: string
  ts: string
  data?: Record<string, unknown>
}

export interface WorkerChildSpec {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface WorkerSpawnContext {
  runId: string
  pipeline?: string
  mode: 'run' | 'resume'
  spec: WorkerChildSpec
}

export interface ChildHandle {
  pid?: number
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  kill(signal?: NodeJS.Signals): boolean
}

export interface WorkerRunOptions {
  mainUrl: string
  token?: string
  name?: string
  tags?: string[]
  maxRuns?: number
  allowPipelines?: string[]
  projectRoot?: string
  logger?: RemoteRunLogger
  reconnectDelayMs?: number
  heartbeatIntervalMs?: number
  projectPollIntervalMs?: number
  spawnChild?: (context: WorkerSpawnContext) => ChildHandle
  signal?: AbortSignal
}

interface ActiveRun {
  runId: string
  pipeline?: string
  child: ChildHandle
  cancelled: boolean
}

/** Parse `mt worker --main URL --token-ref REF [--name N] [--tag a,b] ...`. */
export function parseWorkerArgs(args: readonly string[]): WorkerCommandOptions {
  const options: WorkerCommandOptions = {
    tags: [],
    maxRuns: DEFAULT_MAX_RUNS,
    allowPipelines: [...DEFAULT_ALLOW_PIPELINES],
  }
  let allowExplicit = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === undefined) continue
    const value = (): string => {
      const next = args[++index]
      if (next === undefined || next === '') throw new Error(`${arg} requires a value`)
      return next
    }
    if (arg === '--main' || arg.startsWith('--main=')) {
      options.mainUrl = arg.startsWith('--main=') ? arg.slice('--main='.length) : value()
    } else if (arg === '--token-ref' || arg.startsWith('--token-ref=')) {
      options.tokenRef = arg.startsWith('--token-ref=') ? arg.slice('--token-ref='.length) : value()
    } else if (arg === '--name' || arg.startsWith('--name=')) {
      options.name = arg.startsWith('--name=') ? arg.slice('--name='.length) : value()
    } else if (arg === '--tag' || arg.startsWith('--tag=')) {
      const raw = arg.startsWith('--tag=') ? arg.slice('--tag='.length) : value()
      options.tags.push(
        ...raw
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      )
    } else if (arg === '--max-runs' || arg.startsWith('--max-runs=')) {
      const raw = arg.startsWith('--max-runs=') ? arg.slice('--max-runs='.length) : value()
      const parsed = Number.parseInt(raw, 10)
      if (!Number.isFinite(parsed) || parsed < 1) throw new Error('--max-runs must be >= 1')
      options.maxRuns = parsed
    } else if (arg === '--allow-pipeline' || arg.startsWith('--allow-pipeline=')) {
      if (!allowExplicit) {
        options.allowPipelines = []
        allowExplicit = true
      }
      options.allowPipelines.push(
        arg.startsWith('--allow-pipeline=') ? arg.slice('--allow-pipeline='.length) : value(),
      )
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(
        'Usage: mt worker --main <url> [--token-ref <ENV_OR_REF>] [--name <name>] [--tag a,b] [--max-runs N] [--allow-pipeline GLOB]',
      )
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown worker option: ${arg}`)
    }
  }
  return options
}

function defaultSpawn(context: WorkerSpawnContext): ChildHandle {
  const child = spawn(context.spec.command, context.spec.args, {
    cwd: context.spec.cwd,
    env: context.spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return child as unknown as ChildHandle
}

function childSpec(
  options: WorkerRunOptions,
  mirrorRoot: string,
  mode: 'run' | 'resume',
  runId: string,
  pipeline: string | undefined,
): WorkerChildSpec {
  // Same argv rule as `serve.ts detachServe`: a compiled Bun binary is argv[1] === /$bunfs/*;
  // otherwise process.argv[1] is the CLI script to re-enter.
  const compiled = process.argv[1]?.startsWith('/$bunfs') === true
  const entry = compiled ? [] : [process.argv[1] as string]
  const command = process.execPath
  const runArgs =
    mode === 'run'
      ? ['run', pipeline ?? '', '--run-id', runId, '--report-to', options.mainUrl]
      : ['resume', runId, '--report-to', options.mainUrl]
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (options.token !== undefined) env.MT_WORKER_MAIN_TOKEN = options.token
  return { command, args: [...entry, ...runArgs], cwd: mirrorRoot, env }
}

function normalizeSignal(value: unknown): WorkerSignal | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'number' || typeof record.type !== 'string') return undefined
  if (typeof record.ts !== 'string') return undefined
  return {
    id: record.id,
    type: record.type,
    ts: record.ts,
    ...(typeof record.data === 'object' && record.data !== null
      ? { data: record.data as Record<string, unknown> }
      : {}),
  }
}

function parseSseBlock(block: string): { id?: number; data?: string } {
  let id: number | undefined
  const data: string[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith(':')) continue
    if (line.startsWith('id:')) {
      const parsed = Number(line.slice(3).trim())
      if (Number.isSafeInteger(parsed) && parsed >= 0) id = parsed
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart())
    }
  }
  return data.length === 0 ? { id } : { id, data: data.join('\n') }
}

function endpoint(base: string, path: string): string {
  return new URL(path, `${base.replace(/\/+$/, '')}/`).toString()
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** One SSE connection. Returns the last seen signal id; resolves on a clean close. */
async function consumeSignalStream(
  options: WorkerRunOptions,
  workerId: string,
  afterId: number,
  signal: AbortSignal,
  onSignal: (signal: WorkerSignal) => void,
): Promise<number> {
  const response = await fetch(
    endpoint(options.mainUrl, `/api/workers/${encodeURIComponent(workerId)}/signals`),
    {
      headers: {
        Accept: 'text/event-stream',
        'Last-Event-ID': String(afterId),
        ...authHeaders(options.token),
      },
      signal,
    },
  )
  if (!response.ok) {
    throw new Error(`Worker signal stream failed (${response.status})`)
  }
  if (response.body === null) throw new Error('Worker signal stream has no body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastId = afterId
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const parsed = parseSseBlock(block)
      if (parsed.id !== undefined) lastId = parsed.id
      if (parsed.data !== undefined) {
        try {
          const signalValue = normalizeSignal(JSON.parse(parsed.data))
          if (signalValue !== undefined && signalValue.id > afterId) onSignal(signalValue)
        } catch {
          // A malformed signal is dropped; the ring replays it on the next reconnect.
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
  return lastId
}

async function longPollSignals(
  options: WorkerRunOptions,
  workerId: string,
  afterId: number,
  signal: AbortSignal,
): Promise<WorkerSignal[]> {
  const response = await fetch(
    endpoint(options.mainUrl, `/api/workers/${encodeURIComponent(workerId)}/signals?wait=25`),
    {
      headers: {
        Accept: 'application/json',
        'Last-Event-ID': String(afterId),
        ...authHeaders(options.token),
      },
      signal,
    },
  )
  if (!response.ok) throw new Error(`Worker signal poll failed (${response.status})`)
  const body = (await response.json()) as { signals?: unknown }
  if (!Array.isArray(body.signals)) return []
  return body.signals
    .map((value) => normalizeSignal(value))
    .filter((value): value is WorkerSignal => value !== undefined)
}

function logStream(stream: NodeJS.ReadableStream | null, logger: RemoteRunLogger, prefix: string) {
  if (stream === null) return
  const lines = createInterface({ input: stream })
  lines.on('line', (line) => logger.info(`${prefix} ${line}`))
}

/**
 * `mt worker`: register with the main backend, mirror its project, hold the signal
 * channel, and spawn one child `mt` process per `run` signal. Drain finishes active
 * runs then exits 0; a child crash is reported as failed and never kills the worker.
 */
export async function runWorker(options: WorkerRunOptions): Promise<number> {
  const logger: RemoteRunLogger = options.logger ?? workerLogger()
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS
  const allowPipelines = options.allowPipelines ?? DEFAULT_ALLOW_PIPELINES
  const root = options.projectRoot ?? process.cwd()
  const mirrorRoot = workerMirrorPath(root, options.mainUrl)
  const registration: WorkerRegistrationBody = {
    name: options.name?.trim() || hostname(),
    tags: options.tags ?? [],
    mtVersion: MT_VERSION,
  }
  const record = await registerWorkerWithMain(
    { url: options.mainUrl, token: options.token },
    registration,
  )
  logger.info('Worker registered', { workerId: record.id, main: options.mainUrl })

  let lastId = 0
  let stopped = false
  let draining = false
  let resolveDone: (() => void) | undefined
  const active = new Map<string, ActiveRun>()
  const queue: WorkerSignal[] = []
  let pullChain: Promise<void> = Promise.resolve()
  let pullDirty = true
  let launching = 0

  const done = (): void => {
    if (resolveDone !== undefined) resolveDone()
  }

  const pullProject = async (): Promise<void> => {
    const next = pullChain.then(async () => {
      try {
        const result = await pullWorkerProject(
          root,
          mirrorRoot,
          { url: options.mainUrl, token: options.token },
          record.id,
        )
        if (result.transferred > 0) {
          logger.info('Worker project mirrored', {
            workerId: record.id,
            files: result.transferred,
            bytes: result.bytes,
          })
        }
        pullDirty = false
      } catch (error) {
        logger.warn('Worker project pull failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
    pullChain = next.catch(() => undefined)
    await next
  }

  const ensureFreshProject = async (): Promise<void> => {
    if (pullDirty) await pullProject()
  }

  const reconcileTerminal = async (runId: string): Promise<void> => {
    let localState: string | undefined
    try {
      const raw = await readFile(join(mirrorRoot, '.mt', 'runs', runId, 'state.json'), 'utf8')
      const parsed = JSON.parse(raw) as { state?: unknown }
      if (typeof parsed.state === 'string') localState = parsed.state
    } catch {
      return
    }
    if (localState !== 'done' && localState !== 'failed' && localState !== 'paused') return
    const mainState = await getMainRunState({ url: options.mainUrl, token: options.token }, runId)
    if (mainState === 'done' || mainState === 'failed' || mainState === 'paused') return
    try {
      await postRunEvents(
        { url: options.mainUrl, token: options.token },
        runId,
        `${JSON.stringify({
          type: localState,
          ts: new Date().toISOString(),
          runId,
        })}\n`,
      )
    } catch (error) {
      logger.warn('Worker failed to reconcile the run terminal state', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const reportFailure = async (runId: string, message: string): Promise<void> => {
    const event = {
      type: 'failed',
      ts: new Date().toISOString(),
      runId,
      error: message,
    }
    try {
      await postRunEvents(
        { url: options.mainUrl, token: options.token },
        runId,
        `${JSON.stringify(event)}\n`,
      )
    } catch (error) {
      logger.warn('Worker failed to report child failure', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const pump = (): void => {
    while (!draining && active.size + launching < maxRuns && queue.length > 0) {
      const next = queue.shift()
      if (next !== undefined) void launch(next)
    }
    if (draining && active.size === 0 && launching === 0 && queue.length === 0) {
      stopped = true
      done()
    }
  }

  const launch = async (signal: WorkerSignal): Promise<void> => {
    launching++
    try {
      const runId = typeof signal.data?.runId === 'string' ? signal.data.runId : undefined
      if (runId === undefined) {
        logger.warn('Worker dropped a run signal without a runId', { signalId: signal.id })
        return
      }
      const pipeline = typeof signal.data?.pipeline === 'string' ? signal.data.pipeline : undefined
      const mode = signal.type === 'resume' || signal.data?.resume === true ? 'resume' : 'run'

      if (mode === 'run' && pipeline === undefined) {
        await reportFailure(runId, 'Worker run signal is missing the pipeline path')
        return
      }
      if (mode === 'run' && pipeline !== undefined && !matchesAnyGlob(pipeline, allowPipelines)) {
        logger.warn('Worker refused a pipeline outside its allow list', { runId, pipeline })
        await reportFailure(
          runId,
          `Pipeline '${pipeline}' is not allowed on this worker (allow: ${allowPipelines.join(', ')})`,
        )
        return
      }

      await ensureFreshProject()
      const spec = childSpec(options, mirrorRoot, mode, runId, pipeline)
      let child: ChildHandle
      try {
        child = (options.spawnChild ?? defaultSpawn)({ runId, pipeline, mode, spec })
      } catch (error) {
        await reportFailure(runId, error instanceof Error ? error.message : String(error))
        return
      }

      const activeRun: ActiveRun = { runId, pipeline, child, cancelled: false }
      active.set(runId, activeRun)
      logger.info(`Worker started ${mode === 'run' ? 'run' : 'resume'}: ${runId}`, {
        workerId: record.id,
        ...(pipeline === undefined ? {} : { pipeline }),
      })
      logStream(child.stdout, logger, `[run:${runId}]`)
      logStream(child.stderr, logger, `[run:${runId}]`)

      child.on('error', (error) => {
        logger.error(`Worker child failed to start: ${runId}`, { error: error.message })
      })
      child.on('exit', (code, exitSignal) => {
        active.delete(runId)
        if (code !== 0) {
          const message = activeRun.cancelled
            ? 'Run cancelled by worker signal'
            : `Worker child exited with ${code ?? 'null'}${exitSignal ? ` (${exitSignal})` : ''}`
          logger.warn(`Worker child failed: ${runId}`, { code, signal: exitSignal })
          void reportFailure(runId, message)
        } else {
          logger.info(`Worker child finished: ${runId}`, { code })
          // The reporter usually posted the terminal event, but a flush race must not
          // leave the main record running forever.
          void reconcileTerminal(runId)
        }
        pump()
      })
    } finally {
      launching--
      pump()
    }
  }

  const handleSignal = (signal: WorkerSignal): void => {
    if (signal.type === 'project-changed') {
      pullDirty = true
      void pullProject()
      return
    }
    if (signal.type === 'drain') {
      if (!draining) {
        draining = true
        logger.info('Worker draining; finishing active runs', {
          workerId: record.id,
          active: active.size,
        })
        for (const queued of queue.splice(0)) {
          const runId = typeof queued.data?.runId === 'string' ? queued.data.runId : undefined
          if (runId !== undefined) {
            void reportFailure(runId, 'Run not started: worker is draining')
          }
        }
        pump()
      }
      return
    }
    if (signal.type === 'run') {
      if (draining || active.size + launching >= maxRuns) {
        queue.push(signal)
        return
      }
      void launch(signal)
      return
    }
    const runId = typeof signal.data?.runId === 'string' ? signal.data.runId : undefined
    if (runId === undefined) {
      logger.warn(`Worker ignored ${signal.type} signal without a runId`, {
        signalId: signal.id,
      })
      return
    }
    const run = active.get(runId)
    if (signal.type === 'resume') {
      if (run !== undefined) {
        logger.warn('Worker ignored resume: run is still active', { runId })
        return
      }
      if (draining || active.size + launching >= maxRuns) {
        queue.push(signal)
        return
      }
      void launch(signal)
      return
    }
    if (run === undefined) {
      logger.warn(`Worker ignored ${signal.type}: run is not active`, { runId })
      return
    }
    if (signal.type === 'pause') {
      run.child.kill('SIGINT')
    } else if (signal.type === 'cancel') {
      run.cancelled = true
      run.child.kill('SIGTERM')
    }
  }

  const abort = new AbortController()
  const forwardAbort = (): void => abort.abort()
  options.signal?.addEventListener('abort', forwardAbort, { once: true })

  const heartbeat = setInterval(() => {
    void heartbeatWorkerWithMain({ url: options.mainUrl, token: options.token }, record.id).catch(
      (error: unknown) => {
        logger.warn('Worker heartbeat failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      },
    )
  }, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS)

  const poll = setInterval(() => {
    pullDirty = true
    void pullProject().catch(() => undefined)
  }, options.projectPollIntervalMs ?? DEFAULT_PROJECT_POLL_MS)

  const finished = new Promise<void>((resolvePromise) => {
    resolveDone = resolvePromise
  })

  void (async () => {
    await pullProject()
    let failures = 0
    let reconnectDelay = options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS
    while (!stopped && !abort.signal.aborted) {
      try {
        if (failures >= 5) {
          const signals = await longPollSignals(options, record.id, lastId, abort.signal)
          failures = 0
          for (const signal of signals) {
            lastId = Math.max(lastId, signal.id)
            handleSignal(signal)
          }
          continue
        }
        lastId = await consumeSignalStream(
          { ...options, logger },
          record.id,
          lastId,
          abort.signal,
          (signal) => {
            // Advance before dispatch: a reconnect after a crash must not replay the
            // signal that already spawned a child.
            lastId = Math.max(lastId, signal.id)
            handleSignal(signal)
          },
        )
        failures = 0
        reconnectDelay = options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS
      } catch (error) {
        if (stopped || abort.signal.aborted) break
        failures++
        logger.warn('Worker signal stream disconnected; reconnecting', {
          attempt: failures,
          error: error instanceof Error ? error.message : String(error),
        })
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, reconnectDelay))
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS)
      }
    }
    done()
  })()

  try {
    await finished
  } finally {
    clearInterval(heartbeat)
    clearInterval(poll)
    options.signal?.removeEventListener('abort', forwardAbort)
    abort.abort()
  }
  logger.info('Worker stopped', { workerId: record.id })
  return 0
}

function workerLogger(): RemoteRunLogger {
  const logger: Logger = createConsoleLogger()
  return {
    setRunId: () => undefined,
    info: (message, meta) => logger.info(message, meta),
    warn: (message, meta) => logger.warn(message, meta),
    error: (message, meta) => logger.error(message, meta),
    debug: (message, meta) => logger.debug(message, meta),
    flush: async () => undefined,
  }
}

export async function workerCommand(args: string[]): Promise<void> {
  let options: WorkerCommandOptions
  try {
    options = parseWorkerArgs(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  if (options.mainUrl === undefined) {
    console.error(
      'Usage: mt worker --main <url> [--token-ref <ENV_OR_REF>] [--name <name>] [--tag a,b] [--max-runs N] [--allow-pipeline GLOB]',
    )
    process.exit(1)
  }
  const logger = workerLogger()
  const token = await resolveRemoteToken(options.tokenRef)
  const run = (): Promise<number> =>
    runWorker({
      mainUrl: options.mainUrl as string,
      ...(token === undefined ? {} : { token }),
      ...(options.name === undefined ? {} : { name: options.name }),
      tags: options.tags,
      maxRuns: options.maxRuns,
      allowPipelines: options.allowPipelines,
      logger,
    })

  process.once('SIGINT', () => {
    logger.warn('SIGINT received: worker exiting')
    process.exit(1)
  })

  const code = await run()
  process.exit(code)
}

annotate(
  workerCommand,
  useCase('UC032', {
    name: 'Run a pull worker',
    description: 'Register with a main mt serve, mirror its project, run routed signals.',
  }),
)
