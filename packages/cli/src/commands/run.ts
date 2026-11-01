import { basename, extname, join, relative, resolve } from 'node:path'
import {
  Runner,
  defineSuite,
  importPipelineModule,
  isPipeline,
  isPipelineSuite,
  loadGlobalContext,
  nativeAddonHint,
  packageResolutionHint,
} from '@mt/core'
import type { GlobalContext, Pipeline, PipelineSuite } from '@mt/core'

// Ensure built-in sources/targets are registered before resolving URIs
import '@mt/waypoint'

import { DuplexLogger } from '../utils/logger.js'
import { runLifecycleScript } from './utils/lifecycle.js'

/** A module export the CLI can run directly. */
export type Runnable = Pipeline | PipelineSuite

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
  if (args.length === 0) {
    console.error('Usage: mt run <pipeline.ts> [--pipeline <name>]')
    console.error('  Execute a pipeline file (foreground; logs to console + .mt)')
    process.exit(1)
  }

  const pipelineFile = args[0] as string
  const projectRoot = process.cwd()

  // Parse --pipeline <name> flag
  let pipelineName: string | undefined
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--pipeline' && args[i + 1]) {
      pipelineName = args[i + 1]
      break
    }
  }

  // Load the runnable export (pipeline or suite)
  const runnable = await loadRunnable(pipelineFile, pipelineName)

  // Build global context from mt.json
  const globalContext = await loadGlobalContext(projectRoot)

  // Create logger
  const logger = new DuplexLogger(join(projectRoot, '.mt', 'runs'))

  // Lifecycle hook: scripts.start before the main run. A start-hook failure fails the run.
  await runLifecycleScript(globalContext, 'start', { pipelineName, logger })

  const failure = isPipelineSuite(runnable)
    ? await runSuite(runnable, pipelineFile, pipelineName, globalContext, projectRoot, logger)
    : await runPipeline(runnable, pipelineFile, pipelineName, globalContext, projectRoot, logger)

  // scripts.end runs on success AND failure; an end-hook error must not mask the outcome.
  await runSwallowingHookErrors(globalContext, 'end', { pipelineName, logger })

  // scripts.exit runs once as the process is about to leave, after end.
  await runSwallowingHookErrors(globalContext, 'exit', { pipelineName, logger })

  // Make sure the per-run log file is fully written before the process exits
  await logger.flush()

  if (failure !== undefined) process.exit(1)
}

/** Run one pipeline through its own Runner. Returns the failure, if any. */
async function runPipeline(
  pipeline: Pipeline,
  pipelineFile: string,
  pipelineName: string | undefined,
  globalContext: GlobalContext,
  projectRoot: string,
  logger: DuplexLogger,
): Promise<unknown> {
  logger.info(`Starting pipeline: ${pipeline.id}`)
  logger.info(`Pipeline file: ${pipelineFile}`)

  // Create and start runner (record provenance so `mt resume <runId>` finds the file)
  const runner = new Runner(pipeline, globalContext, {
    pipelineFile: relative(projectRoot, resolve(projectRoot, pipelineFile)),
    pipelineName,
  })

  process.on('SIGINT', async () => {
    logger.warn('SIGINT received: pausing pipeline...')
    await runner.pause()
    await runSwallowingHookErrors(globalContext, 'stop', { pipelineName, logger })
    await runSwallowingHookErrors(globalContext, 'exit', { pipelineName, logger })
    await logger.flush()
    console.log(`\n⏸ Pipeline paused. Run ID: ${runner.getRunId()}`)
    console.log(`  Resume with: mt resume ${runner.getRunId()}`)
    process.exit(0)
  })

  try {
    // start() mints the run id synchronously — bind the logger before awaiting the run,
    // so every CLI log line lands in .mt/runs/<runId>/run.log
    const startPromise = runner.start()
    const runId = runner.getRunId()
    if (runId) logger.setRunId(runId)
    const runContext = await startPromise
    logger.info(`Pipeline completed successfully (runId: ${runContext.runId})`)
    console.log(`\n✅ Pipeline complete. Run ID: ${runContext.runId}`)
    return undefined
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const hint = nativeAddonHint(error) || packageResolutionHint(error)
    logger.error(`Pipeline failed: ${errorMessage}`)
    console.error(`\n❌ Pipeline failed: ${errorMessage}${hint}`)
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
    await logger.flush()
    console.log('\n⏸ Suite paused.')
    for (const { runner, pipeline } of running) {
      console.log(`  ${pipeline.id} -> ${runner.getRunId()}`)
    }
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
    logger.info(`Suite completed successfully: ${suite.id}`)
    console.log('\n✅ Suite complete.')
    for (const { runner, pipeline } of running) {
      console.log(`  ${pipeline.id} -> ${runner.getRunId()}`)
    }
    return undefined
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const hint = nativeAddonHint(error) || packageResolutionHint(error)
    logger.error(`Suite failed: ${errorMessage}`)
    console.error(`\n❌ Suite failed: ${errorMessage}${hint}`)
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
    console.error(`\n⚠️ ${name} hook failed: ${hookMessage}`)
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
    return defineSuite(pipelines, { id: suiteId, mode: 'sync' })
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
