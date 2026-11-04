import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isPipeline, isPipelineSuite } from '@mt/core'
import type { Pipeline, PipelineSuite } from '@mt/core'
import {
  type RemoteHealth,
  type ResolvedRemoteConfig,
  assertRemoteCompatible,
  resolveRemoteConfig,
  syncProjectPull,
  syncProjectPush,
} from './remote-client.js'

export interface RemoteRunLogger {
  setRunId(runId: string): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  debug(message: string, meta?: Record<string, unknown>): void
  flush(): Promise<void>
}

export interface RemoteRunFlags {
  url?: string
  tokenRef?: string
  allowVersionMismatch?: boolean
}

export interface RemoteRunOptions {
  projectRoot: string
  logger: RemoteRunLogger
  remote: RemoteRunFlags
  pipelineFile: string
  pipelineName?: string
  artifactIntervalMs?: number
  reconnectDelayMs?: number
}

export interface RemoteResumeOptions {
  projectRoot: string
  logger: RemoteRunLogger
  remote: RemoteRunFlags
  runId: string
  artifactIntervalMs?: number
  reconnectDelayMs?: number
}

export interface RemoteRunOutcome {
  runId: string
  state: 'done' | 'failed' | 'paused'
  exitCode: number
}

type RemoteTerminal = RemoteRunOutcome['state']

interface RemoteEvent {
  type?: string
  ts?: string
  runId?: string
  stepId?: string
  error?: string
}

interface RemoteRunState {
  id?: string
  state?: string
}

const LOCAL_INPUT_SCHEMES = new Set(['jsonl', 'md', 'chapter', 'schema-doc'])
const DEFAULT_ARTIFACT_INTERVAL_MS = 5_000
const DEFAULT_RECONNECT_DELAY_MS = 750

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function endpoint(base: string, path: string, params: Record<string, string | undefined> = {}) {
  const url = new URL(path, `${base.replace(/\/+$/, '')}/`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

async function responseError(response: Response): Promise<Error> {
  let message = ''
  try {
    const body = (await response.text()).trim()
    if (body !== '') {
      try {
        const parsed = JSON.parse(body) as { statusMessage?: unknown; error?: unknown }
        const value = parsed.statusMessage ?? parsed.error
        message = typeof value === 'string' ? value : body
      } catch {
        message = body
      }
    }
  } catch {
    message = ''
  }
  return new Error(
    `Remote request failed (${response.status})${message === '' ? '' : `: ${message.slice(0, 500)}`}`,
  )
}

async function requestJson<T>(
  url: string,
  token: string | undefined,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...authHeaders(token), ...(init.headers ?? {}) },
  })
  if (!response.ok) throw await responseError(response)
  return (await response.json()) as T
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}

function relativePipeline(root: string, pipelineFile: string): string {
  const absolute = resolve(root, pipelineFile)
  const path = toPosixPath(relative(root, absolute))
  if (path === '' || path.startsWith('../') || path === '..' || isAbsolute(path)) {
    throw new Error(`Pipeline is outside the project root: ${pipelineFile}`)
  }
  return path
}

/**
 * Refuse a local source the remote cannot receive. The sync scope only ships
 * relative inputs; an absolute or parent-traversing input would make the remote
 * run silently read a different file (or fail later), so fail before starting.
 */
export async function assertShippableInputs(
  projectRoot: string,
  pipelineFile: string,
): Promise<void> {
  const source = await readFile(resolve(projectRoot, pipelineFile), 'utf8')
  const pattern = /\.from\s*\(\s*['"]([^'"]+)['"]/g
  let match = pattern.exec(source)
  while (match) {
    const uri = match[1]
    if (uri !== undefined) assertShippableUri(uri)
    match = pattern.exec(source)
  }
}

function assertShippableUri(uri: string): void {
  const parsed = /^([a-z][a-z0-9+.-]*):\/\/([^?#]+)/i.exec(uri)
  const scheme = parsed?.[1]?.toLowerCase()
  const rawPath = parsed?.[2]
  if (scheme === undefined || rawPath === undefined) return
  if (!LOCAL_INPUT_SCHEMES.has(scheme)) return
  let decoded = rawPath
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    // Keep the literal path; traversal checks still apply.
  }
  const normalized = decoded.replace(/^\.\//, '')
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('~') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(
      `Input not shippable: ${uri}. Use a path relative to the project root so the remote can receive it.`,
    )
  }
}

function collectToolNames(runnable: Pipeline | PipelineSuite): string[] {
  const pipelines = isPipelineSuite(runnable) ? runnable.pipelines : [runnable]
  const names = new Set<string>()
  const visit = (pipeline: Pipeline): void => {
    for (const step of pipeline.steps) {
      if (step.type === 'tool') {
        const name = step.config.name
        if (typeof name === 'string') names.add(name)
      }
      const nested = step.config.pipeline
      if (isPipeline(nested)) visit(nested)
      const branches = step.config.pipelines
      if (Array.isArray(branches)) {
        for (const branch of branches) if (isPipeline(branch)) visit(branch)
      }
    }
  }
  for (const pipeline of pipelines) visit(pipeline)
  return [...names]
}

type CapabilityName = keyof NonNullable<RemoteHealth['capabilities']> & string

function requiredCapabilities(tool: string): CapabilityName[] {
  const lower = tool.toLowerCase()
  const required: CapabilityName[] = []
  if (lower.includes('browser-translate') || lower.includes('browsertranslate')) {
    required.push('chrome')
  }
  if (lower.includes('docker') || lower.includes('container')) required.push('docker')
  if (lower.includes('playwright')) required.push('playwright')
  return required
}

/** Fail fast when the remote cannot run a declared tool. Unknown tools pass. */
export function assertCapabilities(runnable: Pipeline | PipelineSuite, health: RemoteHealth): void {
  const capabilities = health.capabilities
  if (!capabilities) return
  for (const tool of collectToolNames(runnable)) {
    for (const capability of requiredCapabilities(tool)) {
      if (!capabilities[capability]) {
        throw new Error(
          `Remote is missing capability '${capability}' required by tool '${tool}' (${health.version ?? 'unknown version'})`,
        )
      }
    }
  }
}

async function connectOnce(
  base: string,
  token: string | undefined,
  runId: string,
  projectId: string | undefined,
  lastEventId: number,
  logger: RemoteRunLogger,
  ignoreInitialPause: boolean,
): Promise<{ terminal?: RemoteTerminal; lastEventId: number }> {
  const controller = new AbortController()
  const response = await fetch(
    endpoint(base, `/api/runs/${encodeURIComponent(runId)}/events`, {
      stream: 'true',
      projectId,
    }),
    {
      headers: {
        Accept: 'text/event-stream',
        'Last-Event-ID': String(lastEventId),
        ...authHeaders(token),
      },
      signal: controller.signal,
    },
  )
  if (!response.ok) throw await responseError(response)
  if (response.body === null) throw new Error('Remote event stream has no body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let offset = lastEventId
  let terminal: RemoteTerminal | undefined
  let seenResumed = false

  try {
    while (terminal === undefined) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const parsed = parseSseBlock(block)
        if (parsed.id !== undefined && Number.isSafeInteger(parsed.id)) offset = parsed.id
        if (parsed.data !== undefined) {
          const event = parseRemoteEvent(parsed.data)
          if (event) {
            if (event.type === 'resumed') seenResumed = true
            const ignorePause = event.type === 'paused' && ignoreInitialPause && !seenResumed
            if (!ignorePause) logRemoteEvent(event, logger)
            const next = ignorePause ? undefined : terminalFor(event.type)
            if (next !== undefined) terminal = next
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    controller.abort()
    void reader.cancel().catch(() => undefined)
  }

  return terminal === undefined ? { lastEventId: offset } : { terminal, lastEventId: offset }
}

function parseSseBlock(block: string): { id?: number; data?: string } {
  let id: number | undefined
  const data: string[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('id:')) {
      const parsed = Number(line.slice(3).trim())
      if (Number.isSafeInteger(parsed) && parsed >= 0) id = parsed
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart())
    }
  }
  return data.length === 0 ? { id } : { id, data: data.join('\n') }
}

function parseRemoteEvent(data: string): RemoteEvent | undefined {
  if (data === '' || data === '{}') return undefined
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as RemoteEvent
  } catch {
    return undefined
  }
}

function terminalFor(type: string | undefined): RemoteTerminal | undefined {
  if (type === 'done') return 'done'
  if (type === 'failed') return 'failed'
  if (type === 'paused') return 'paused'
  return undefined
}

function logRemoteEvent(event: RemoteEvent, logger: RemoteRunLogger): void {
  const meta = { runId: event.runId, stepId: event.stepId, ts: event.ts }
  if (event.type === 'failed') {
    logger.error(`Remote run failed: ${event.error ?? 'unknown error'}`, meta)
  } else if (event.type === 'done') {
    logger.info('Remote run complete', meta)
  } else if (event.type === 'paused') {
    logger.warn('Remote run paused', meta)
  } else {
    logger.info(`Remote event: ${event.type ?? 'message'}`, meta)
  }
}

async function readRemoteState(
  base: string,
  token: string | undefined,
  runId: string,
  projectId: string | undefined,
): Promise<RemoteRunState | undefined> {
  try {
    return await requestJson<RemoteRunState>(
      endpoint(base, `/api/runs/${encodeURIComponent(runId)}`, { projectId }),
      token,
    )
  } catch {
    return undefined
  }
}

function stateTerminal(state: string | undefined): RemoteTerminal | undefined {
  if (state === 'done') return 'done'
  if (state === 'failed') return 'failed'
  if (state === 'paused') return 'paused'
  return undefined
}

async function waitForTerminal(
  config: ResolvedRemoteConfig,
  runId: string,
  logger: RemoteRunLogger,
  initialEventId: number,
  reconnectDelayMs: number,
  ignoreInitialPause: boolean,
  projectId: string | undefined = config.projectId,
): Promise<RemoteTerminal> {
  let lastEventId = initialEventId
  for (;;) {
    try {
      const result = await connectOnce(
        config.url,
        config.token,
        runId,
        projectId,
        lastEventId,
        logger,
        ignoreInitialPause,
      )
      lastEventId = result.lastEventId
      if (result.terminal !== undefined) return result.terminal
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('Remote event stream disconnected; reconnecting', {
        error: message,
      })
      const state = await readRemoteState(config.url, config.token, runId, projectId)
      const terminal = stateTerminal(state?.state)
      if (terminal !== undefined) return terminal
      if (message.includes('(404)') && state === undefined) {
        throw new Error(`Remote run not found or no event log: ${runId}`)
      }
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, reconnectDelayMs))
  }
}

async function pullArtifacts(
  config: ResolvedRemoteConfig,
  projectRoot: string,
  runId: string,
  logger: RemoteRunLogger,
  final: boolean,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await syncProjectPull({
        root: projectRoot,
        url: config.url,
        token: config.token,
        projectId: config.projectId,
        runId,
        force: true,
        allowVersionMismatch: true,
      })
      if (result.transferred > 0 || final) {
        logger.info('Remote artifacts pulled', {
          runId,
          transferred: result.transferred,
          bytes: result.bytes,
          final,
        })
      }
      return
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      if (!/Size mismatch|Checksum mismatch/.test(message) || attempt === 2) break
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100 * (attempt + 1)))
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  if (final) throw new Error(`Failed to pull remote artifacts: ${message}`)
  logger.warn('Remote artifact pull failed; will retry', { runId, error: message })
}

async function localEventOffset(projectRoot: string, runId: string): Promise<number> {
  try {
    return (await stat(resolve(projectRoot, '.mt', 'runs', runId, 'events.jsonl'))).size
  } catch {
    return 0
  }
}

function installPauseHandler(
  config: ResolvedRemoteConfig,
  runId: string,
  logger: RemoteRunLogger,
  pullFinal: () => Promise<void>,
): () => void {
  let pressed = 0
  let busy = false
  const handler = async (): Promise<void> => {
    pressed++
    if (pressed > 1 || busy) {
      logger.info('Detached from remote run', { runId })
      process.exit(0)
    }
    busy = true
    logger.warn('SIGINT received: pausing remote run...', { runId })
    try {
      await requestJson(
        endpoint(config.url, `/api/runs/${encodeURIComponent(runId)}/pause`),
        config.token,
        { method: 'POST' },
      )
      await pullFinal()
    } catch (err) {
      logger.warn('Remote pause failed', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    logger.info(`Remote run paused. Run ID: ${runId}`)
    logger.info(`Resume: mt resume ${runId} --remote ${config.url}`)
    await logger.flush()
    process.exit(0)
  }
  process.on('SIGINT', handler)
  return () => process.off('SIGINT', handler)
}

async function resolveRemote(
  projectRoot: string,
  flags: RemoteRunFlags,
): Promise<ResolvedRemoteConfig> {
  return resolveRemoteConfig(projectRoot, {
    url: flags.url,
    tokenRef: flags.tokenRef,
  })
}

async function startRun(
  config: ResolvedRemoteConfig,
  pipeline: string,
  pipelineName: string | undefined,
): Promise<string> {
  const started = await requestJson<{ runId?: unknown }>(
    endpoint(config.url, '/api/runs/start'),
    config.token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: config.projectId,
        pipeline,
        ...(pipelineName === undefined ? {} : { pipelineName }),
      }),
    },
  )
  if (typeof started.runId !== 'string' || started.runId === '') {
    throw new Error('Remote start response did not include a runId')
  }
  return started.runId
}

async function watchRemoteRun(
  config: ResolvedRemoteConfig,
  projectRoot: string,
  runId: string,
  logger: RemoteRunLogger,
  initialEventId: number,
  artifactIntervalMs: number,
  reconnectDelayMs: number,
  ignoreInitialPause: boolean,
): Promise<RemoteRunOutcome> {
  logger.setRunId(runId)

  let pullChain: Promise<void> = Promise.resolve()
  const pull = async (final: boolean): Promise<void> => {
    const next = pullChain.then(() => pullArtifacts(config, projectRoot, runId, logger, final))
    pullChain = next.catch(() => undefined)
    await next
  }
  const removePauseHandler = installPauseHandler(config, runId, logger, () => pull(true))

  let stopped = false
  const timer = setInterval(() => {
    if (!stopped) void pull(false)
  }, artifactIntervalMs)
  try {
    const terminal = await waitForTerminal(
      config,
      runId,
      logger,
      initialEventId,
      reconnectDelayMs,
      ignoreInitialPause,
    )
    await pull(true)
    return {
      runId,
      state: terminal,
      exitCode: terminal === 'failed' ? 1 : 0,
    }
  } finally {
    stopped = true
    clearInterval(timer)
    await pullChain.catch(() => undefined)
    removePauseHandler()
  }
}

/** `mt run <pipeline> --remote`: push, start, stream, pull. */
export async function runRemotePipeline(options: RemoteRunOptions): Promise<RemoteRunOutcome> {
  const { logger } = options
  const config = await resolveRemote(options.projectRoot, options.remote)
  const health = await assertRemoteCompatible(
    config.url,
    config.token,
    options.remote.allowVersionMismatch === true,
  )

  const runnable = await loadLocalRunnable(
    options.projectRoot,
    options.pipelineFile,
    options.pipelineName,
  )
  assertCapabilities(runnable, health)
  await assertShippableInputs(options.projectRoot, options.pipelineFile)

  logger.info('Remote run push start', {
    projectId: config.projectId,
    url: config.url,
  })
  await syncProjectPush({
    root: options.projectRoot,
    url: config.url,
    token: config.token,
    projectId: config.projectId,
    include: config.include,
    exclude: config.exclude,
    maxFileBytes: config.maxFileBytes,
    allowVersionMismatch: options.remote.allowVersionMismatch === true,
  })

  const pipeline = relativePipeline(options.projectRoot, options.pipelineFile)
  const runId = await startRun(config, pipeline, options.pipelineName)
  logger.info(`Remote run started: ${runId}`, { projectId: config.projectId, url: config.url })
  logger.info(`Resume: mt resume ${runId} --remote ${config.url}`)

  return watchRemoteRun(
    config,
    options.projectRoot,
    runId,
    logger,
    0,
    options.artifactIntervalMs ?? DEFAULT_ARTIFACT_INTERVAL_MS,
    options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
    false,
  )
}

/** `mt resume <runId> --remote`: unpause if needed, then re-attach to the stream. */
export async function resumeRemotePipeline(
  options: RemoteResumeOptions,
): Promise<RemoteRunOutcome> {
  const { logger, runId } = options
  const config = await resolveRemote(options.projectRoot, options.remote)
  await assertRemoteCompatible(
    config.url,
    config.token,
    options.remote.allowVersionMismatch === true,
  )

  const state = await readRemoteState(config.url, config.token, runId, config.projectId)
  const terminal = stateTerminal(state?.state)
  if (terminal === 'done' || terminal === 'failed') {
    await pullArtifacts(config, options.projectRoot, runId, logger, true)
    return { runId, state: terminal, exitCode: terminal === 'failed' ? 1 : 0 }
  }
  if (state?.state === 'paused') {
    await requestJson(
      endpoint(config.url, `/api/runs/${encodeURIComponent(runId)}/resume`),
      config.token,
      { method: 'POST' },
    )
  }

  logger.setRunId(runId)
  logger.info(`Resuming remote run: ${runId}`, { projectId: config.projectId, url: config.url })
  logger.info(`Resume: mt resume ${runId} --remote ${config.url}`)
  const initialEventId = await localEventOffset(options.projectRoot, runId)
  return watchRemoteRun(
    config,
    options.projectRoot,
    runId,
    logger,
    initialEventId,
    options.artifactIntervalMs ?? DEFAULT_ARTIFACT_INTERVAL_MS,
    options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
    true,
  )
}

export interface RemoteWorkerRunOptions {
  projectRoot: string
  logger: RemoteRunLogger
  remote: RemoteRunFlags
  pipelineFile: string
  pipelineName?: string
  worker?: string
  tags?: string[]
  reconnectDelayMs?: number
}

async function startOnWorker(
  config: ResolvedRemoteConfig,
  pipeline: string,
  pipelineName: string | undefined,
  worker: string | undefined,
  tags: string[] | undefined,
): Promise<string> {
  const started = await requestJson<{ runId?: unknown }>(
    endpoint(config.url, '/api/runs/start'),
    config.token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipeline,
        ...(pipelineName === undefined ? {} : { pipelineName }),
        ...(worker === undefined ? {} : { worker }),
        ...(tags === undefined ? {} : { tags }),
      }),
    },
  )
  if (typeof started.runId !== 'string' || started.runId === '') {
    throw new Error('Worker start response did not include a runId')
  }
  return started.runId
}

/**
 * `mt run <pipeline> --on <worker>` / `--tags a,b`: the main backend owns the run
 * record, sends the `run` signal, and this client just follows the main event stream.
 */
export async function runOnWorker(options: RemoteWorkerRunOptions): Promise<RemoteRunOutcome> {
  const { logger } = options
  const config = await resolveRemote(options.projectRoot, options.remote)
  await assertRemoteCompatible(
    config.url,
    config.token,
    options.remote.allowVersionMismatch === true,
  )
  const pipeline = relativePipeline(options.projectRoot, options.pipelineFile)
  const runId = await startOnWorker(
    config,
    pipeline,
    options.pipelineName,
    options.worker,
    options.tags,
  )
  logger.setRunId(runId)
  logger.info(`Worker run started: ${runId}`, {
    url: config.url,
    ...(options.worker === undefined ? {} : { worker: options.worker }),
    ...(options.tags === undefined ? {} : { tags: options.tags }),
  })
  const terminal = await waitForTerminal(
    config,
    runId,
    logger,
    0,
    options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
    false,
    undefined,
  )
  return { runId, state: terminal, exitCode: terminal === 'failed' ? 1 : 0 }
}

async function loadLocalRunnable(
  projectRoot: string,
  pipelineFile: string,
  pipelineName: string | undefined,
): Promise<Pipeline | PipelineSuite> {
  const { loadRunnable } = await import('../commands/run.js')
  return loadRunnable(resolve(projectRoot, pipelineFile), pipelineName)
}
