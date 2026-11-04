import { basename, extname, join, relative, resolve } from 'node:path'
import {
  Runner,
  annotate,
  defineProcess,
  importPipelineModule,
  isPipeline,
  isPipelineSuite,
  loadGlobalContext,
  nativeAddonHint,
  packageResolutionHint,
  useCase,
} from '@mt/core'
import type { GlobalContext, Pipeline, PipelineSuite } from '@mt/core'

// Ensure built-in sources/targets are registered before resolving URIs
import '@mt/waypoint'

import { DuplexLogger } from '../utils/logger.js'
import { type RemoteRunFlags, runOnWorker, runRemotePipeline } from '../utils/remote-run.js'
import { RunReporter } from '../utils/run-report.js'
import { runLifecycleScript } from './utils/lifecycle.js'

/** A module export the CLI can run directly. */
export type Runnable = Pipeline | PipelineSuite

export interface RunCommandOptions {
  pipelineFile?: string
  pipelineName?: string
  remote?: RemoteRunFlags
  /** Hidden worker-child mode: replay the main-minted run id. */
  runId?: string
  /** Hidden worker-child mode: post events to this main `mt serve`. */
  reportTo?: string
  /** Route to one worker (main-side `POST /api/runs/start`). */
  worker?: string
  /** Route to the first online worker carrying every tag. */
  tags?: string[]
}

/**
 * Parse `mt run` flags. `--remote` alone uses `mt.json -> remote.url`;
 * `--remote <url>` overrides it for this invocation only.
 */
export function parseRunArgs(args: readonly string[]): RunCommandOptions {
  const options: RunCommandOptions = {}
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === '--pipeline') {
      const value = args[++index]
      if (value === undefined) throw new Error('--pipeline requires a named export')
      options.pipelineName = value
    } else if (arg === '--remote' || arg.startsWith('--remote=')) {
      const remote = options.remote ?? {}
      options.remote = remote
      const inline = arg.startsWith('--remote=') ? arg.slice('--remote='.length) : undefined
      if (inline !== undefined && inline !== '') {
        remote.url = inline
      } else {
        const next = args[index + 1]
        if (next !== undefined && /^https?:\/\//.test(next)) {
          remote.url = next
          index++
        }
      }
    } else if (arg === '--token-ref' || arg.startsWith('--token-ref=')) {
      const inline = arg.startsWith('--token-ref=') ? arg.slice('--token-ref='.length) : undefined
      const value = inline ?? args[++index]
      if (value === undefined || value === '') throw new Error('--token-ref requires a value')
      options.remote = { ...(options.remote ?? {}), tokenRef: value }
    } else if (arg === '--allow-version-mismatch') {
      options.remote = { ...(options.remote ?? {}), allowVersionMismatch: true }
    } else if (arg === '--run-id' || arg.startsWith('--run-id=')) {
      const inline = arg.startsWith('--run-id=') ? arg.slice('--run-id='.length) : undefined
      const value = inline ?? args[++index]
      if (value === undefined || value === '') throw new Error('--run-id requires a value')
      options.runId = value
    } else if (arg === '--report-to' || arg.startsWith('--report-to=')) {
      const inline = arg.startsWith('--report-to=') ? arg.slice('--report-to='.length) : undefined
      const value = inline ?? args[++index]
      if (value === undefined || value === '') throw new Error('--report-to requires a value')
      options.reportTo = value
    } else if (arg === '--on' || arg.startsWith('--on=')) {
      const inline = arg.startsWith('--on=') ? arg.slice('--on='.length) : undefined
      const value = inline ?? args[++index]
      if (value === undefined || value === '') throw new Error('--on requires a worker name')
      options.worker = value
    } else if (arg === '--tags' || arg.startsWith('--tags=')) {
      const inline = arg.startsWith('--tags=') ? arg.slice('--tags='.length) : undefined
      const value = inline ?? args[++index]
      if (value === undefined || value === '') throw new Error('--tags requires a value')
      options.tags = value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown run option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  options.pipelineFile = positional[0]
  return options
}

/**
 * `mt run <pipelineFile>` — execute a pipeline or suite.
 *
 * Without `--pipeline` the default export wins: a suite runs as declared, a
 * pipeline runs alone. Only a module with no default pipeline/suite gets an
 * implicit sync suite built from every exported pipeline (alphabetical).
 *
 * Usage: mt run ./pipelines/example.ts [--pipeline <name>]
 */
export async function runCommand(args: string[]): Promise<void> {
  const parsed = parseRunArgs(args)
  if (parsed.pipelineFile === undefined) {
    console.error(
      'Usage: mt run <pipeline.ts> [--pipeline <name>] [--remote [url]] [--token-ref <ENV_OR_REF>]',
    )
    console.error('  Execute a pipeline file (foreground; logs to console + .mt)')
    process.exit(1)
  }

  const pipelineFile = parsed.pipelineFile
  const pipelineName = parsed.pipelineName
  const projectRoot = process.cwd()

  if (parsed.worker !== undefined || parsed.tags !== undefined) {
    const logger = new DuplexLogger(join(projectRoot, '.mt', 'runs'))
    let outcome: Awaited<ReturnType<typeof runOnWorker>>
    try {
      outcome = await runOnWorker({
        projectRoot,
        logger,
        remote: parsed.remote ?? {},
        pipelineFile,
        pipelineName,
        ...(parsed.worker === undefined ? {} : { worker: parsed.worker }),
        ...(parsed.tags === undefined ? {} : { tags: parsed.tags }),
      })
    } catch (error) {
      logger.error(`Worker run failed: ${error instanceof Error ? error.message : String(error)}`)
      await logger.flush()
      process.exit(1)
    }
    await logger.flush()
    if (outcome.exitCode !== 0) process.exit(outcome.exitCode)
    return
  }

  if (parsed.remote !== undefined) {
    const logger = new DuplexLogger(join(projectRoot, '.mt', 'runs'))
    const artifactIntervalMs = Number(process.env.MT_REMOTE_ARTIFACT_INTERVAL_MS)
    let outcome: Awaited<ReturnType<typeof runRemotePipeline>>
    try {
      outcome = await runRemotePipeline({
        projectRoot,
        logger,
        remote: parsed.remote,
        pipelineFile,
        pipelineName,
        ...(Number.isFinite(artifactIntervalMs) && artifactIntervalMs > 0
          ? { artifactIntervalMs }
          : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`Remote run failed: ${message}`)
      await logger.flush()
      process.exit(1)
    }
    await logger.flush()
    if (outcome.exitCode !== 0) process.exit(outcome.exitCode)
    return
  }

  // Load the runnable export (pipeline or suite)
  const runnable = await loadRunnable(pipelineFile, pipelineName)

  // Build global context from mt.json
  const globalContext = await loadGlobalContext(projectRoot)

  // Create logger
  const logger = new DuplexLogger(join(projectRoot, '.mt', 'runs'))
  const reporter =
    parsed.runId !== undefined && parsed.reportTo !== undefined
      ? new RunReporter({
          mainUrl: parsed.reportTo,
          token: process.env.MT_WORKER_MAIN_TOKEN,
          runId: parsed.runId,
          eventsPath: join(projectRoot, '.mt', 'runs', parsed.runId, 'events.jsonl'),
          logger,
        })
      : undefined

  // Lifecycle hook: scripts.start before the main run. A start-hook failure fails the run.
  await runLifecycleScript(globalContext, 'start', { pipelineName, logger })

  const failure = isPipelineSuite(runnable)
    ? await runSuite(runnable, pipelineFile, pipelineName, globalContext, projectRoot, logger)
    : await runPipeline(
        runnable,
        pipelineFile,
        pipelineName,
        globalContext,
        projectRoot,
        logger,
        parsed.runId,
        reporter,
      )

  // scripts.end runs on success AND failure; an end-hook error must not mask the outcome.
  await runSwallowingHookErrors(globalContext, 'end', { pipelineName, logger })

  // scripts.exit runs once as the process is about to leave, after end.
  await runSwallowingHookErrors(globalContext, 'exit', { pipelineName, logger })

  // Make sure the per-run log file is fully written before the process exits
  await logger.flush()

  if (failure !== undefined) process.exit(1)
}

annotate(
  runCommand,
  useCase('UC005', {
    name: 'Run a pipeline (foreground)',
    description: 'Execute a pipeline from the CLI with live console logs.',
  }),
)

/** Run one pipeline through its own Runner. Returns the failure, if any. */
async function runPipeline(
  pipeline: Pipeline,
  pipelineFile: string,
  pipelineName: string | undefined,
  globalContext: GlobalContext,
  projectRoot: string,
  logger: DuplexLogger,
  runId?: string,
  reporter?: RunReporter,
): Promise<unknown> {
  logger.info(`Starting pipeline: ${pipeline.id}`)
  logger.info(`Pipeline file: ${pipelineFile}`)

  // Create and start runner (record provenance so `mt resume <runId>` finds the file)
  const runner = new Runner(pipeline, globalContext, {
    pipelineFile: relative(projectRoot, resolve(projectRoot, pipelineFile)),
    pipelineName,
    ...(runId === undefined ? {} : { runId }),
  })

  process.on('SIGINT', async () => {
    logger.warn('SIGINT received: pausing pipeline...')
    await runner.pause()
    await reporter?.flush()
    await runSwallowingHookErrors(globalContext, 'stop', { pipelineName, logger })
    await runSwallowingHookErrors(globalContext, 'exit', { pipelineName, logger })
    logger.info(`Pipeline paused. Run ID: ${runner.getRunId()}`)
    logger.info(`Resume with: mt resume ${runner.getRunId()}`)
    await logger.flush()
    process.exit(0)
  })

  try {
    // start() mints the run id synchronously — bind the logger before awaiting the run,
    // so every CLI log line lands in .mt/runs/<runId>/run.log
    const startPromise = runner.start()
    const activeRunId = runner.getRunId()
    if (activeRunId) logger.setRunId(activeRunId)
    await reporter?.start()
    try {
      const runContext = await startPromise
      logger.info(`Pipeline complete. Run ID: ${runContext.runId}`)
      return undefined
    } finally {
      await reporter?.flush()
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const hint = nativeAddonHint(error) || packageResolutionHint(error)
    logger.error(`Pipeline failed: ${errorMessage}${hint}`)
    await runSwallowingHookErrors(globalContext, 'error', { pipelineName, logger })
    return error
  }
}

/** Run a suite, collecting each Runner so SIGINT and the final report cover all pipelines. */
async function runSuite(
  suite: PipelineSuite,
  pipelineFile: string,
  pipelineName: string | undefined,
  globalContext: GlobalContext,
  projectRoot: string,
  logger: DuplexLogger,
): Promise<unknown> {
  logger.info(
    `Starting suite: ${suite.id} (${suite.pipelines.length} pipelines, mode: ${suite.mode})`,
  )
  logger.info(`Pipeline file: ${pipelineFile}`)

  const running: Array<{ runner: Runner; pipeline: Pipeline }> = []

  process.on('SIGINT', async () => {
    logger.warn('SIGINT received: pausing suite...')
    for (const { runner } of running) await runner.pause()
    await runSwallowingHookErrors(globalContext, 'stop', { pipelineName, logger })
    await runSwallowingHookErrors(globalContext, 'exit', { pipelineName, logger })
    logger.info('Suite paused.')
    for (const { runner, pipeline } of running) {
      logger.info(`${pipeline.id} -> ${runner.getRunId()}`)
    }
    await logger.flush()
    process.exit(0)
  })

  try {
    await suite.run(globalContext, {
      pipelineFile: relative(projectRoot, resolve(projectRoot, pipelineFile)),
      pipelineName,
      onRunner: (runner, pipeline) => {
        running.push({ runner, pipeline })
        // start() mints the run id synchronously, before onRunner is called.
        const runId = runner.getRunId()
        if (runId) logger.setRunId(runId)
      },
    })
    logger.info(`Suite complete: ${suite.id}`)
    for (const { runner, pipeline } of running) {
      logger.info(`${pipeline.id} -> ${runner.getRunId()}`)
    }
    return undefined
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const hint = nativeAddonHint(error) || packageResolutionHint(error)
    logger.error(`Suite failed: ${errorMessage}${hint}`)
    await runSwallowingHookErrors(globalContext, 'error', { pipelineName, logger })
    return error
  }
}

/**
 * Run a lifecycle hook and log hook errors without letting them change the
 * command's outcome. Used for `end`, `exit`, `error`, and `stop` hooks.
 */
async function runSwallowingHookErrors(
  ctx: GlobalContext,
  name: import('./utils/lifecycle.js').LifecycleHookName,
  options: { pipelineName?: string; logger: Pick<import('@mt/core').Logger, 'info' | 'warn'> },
): Promise<void> {
  try {
    await runLifecycleScript(ctx, name, options)
  } catch (hookError) {
    const hookMessage = hookError instanceof Error ? hookError.message : String(hookError)
    options.logger.warn(`${name} hook failed: ${hookMessage}`)
  }
}

/**
 * Collect all exported pipelines from a module: default (or legacy `pipeline`)
 * first, then the remaining exports alphabetically, deduped by identity.
 */
export function collectPipelines(mod: Record<string, unknown>): Pipeline[] {
  const pipelines: Pipeline[] = []
  const seen = new Set<Pipeline>()

  const add = (value: unknown): void => {
    if (!isPipeline(value) || seen.has(value)) return
    seen.add(value)
    pipelines.push(value)
  }

  const primaryKey = 'default' in mod ? 'default' : 'pipeline' in mod ? 'pipeline' : undefined
  if (primaryKey) add(mod[primaryKey])
  for (const key of Object.keys(mod).sort()) {
    if (key === primaryKey) continue
    add(mod[key])
  }

  return pipelines
}

/**
 * Resolve the runnable export for `mt run`.
 *
 * 1. `--pipeline <name>` selects exactly that export (pipeline or suite).
 * 2. A suite default export is run as-is.
 * 3. A pipeline default export (`mod.default ?? mod.pipeline`) runs alone.
 * 4. Otherwise every exported pipeline becomes an implicit sync suite.
 */
export async function loadRunnable(filePath: string, name?: string): Promise<Runnable> {
  const resolvedPath = resolve(process.cwd(), filePath)
  const mod = (await importPipelineModule(resolvedPath)) as Record<string, unknown>

  if (name) {
    const selected = name in mod ? mod[name] : undefined
    if (isPipelineSuite(selected) || isPipeline(selected)) return selected
    // Legacy modules/tests may expose an id-only pipeline object.
    if (isLegacyPipeline(selected)) return selected
    throw new Error(
      `Invalid pipeline module: ${filePath}. (named export '${name}' not found or invalid)`,
    )
  }

  const primaryKey = 'default' in mod ? 'default' : 'pipeline' in mod ? 'pipeline' : undefined
  const primary = primaryKey ? mod[primaryKey] : undefined
  if (isPipelineSuite(primary)) return primary
  if (isPipeline(primary) || isLegacyPipeline(primary)) return primary

  const pipelines = collectPipelines(mod)
  if (pipelines.length > 0) {
    const suiteId = `${basename(filePath, extname(filePath))}-suite`
    return defineProcess(pipelines, { id: suiteId })
  }

  throw new Error(
    `Invalid pipeline module: ${filePath}. Expected a default pipeline/suite export or exported pipelines from definePipeline().`,
  )
}

function isLegacyPipeline(value: unknown): value is Pipeline {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  )
}
