import { join, relative, resolve } from 'node:path'
import {
  Runner,
  importPipelineModule,
  loadGlobalContext,
  nativeAddonHint,
  packageResolutionHint,
} from '@mt/core'
import type { GlobalContext, Pipeline } from '@mt/core'

// Ensure built-in sources/targets are registered before resolving URIs
import '@mt/waypoint'

import { DuplexLogger } from '../utils/logger.js'
import { runLifecycleScript } from './utils/lifecycle.js'

/**
 * `mt run <pipelineFile>` — execute a pipeline.
 *
 * Usage: mt run ./pipelines/example.ts
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

  // Load pipeline module
  const pipeline = await loadPipeline(pipelineFile, pipelineName)

  // Build global context from mt.json
  const globalContext = await loadGlobalContext(projectRoot)

  // Create logger
  const logger = new DuplexLogger(join(projectRoot, '.mt', 'runs'))

  logger.info(`Starting pipeline: ${pipeline.id}`)
  logger.info(`Pipeline file: ${pipelineFile}`)

  // Lifecycle hook: scripts.start before the main pipeline. A start-hook failure fails the run.
  await runLifecycleScript(globalContext, 'start', { pipelineName, logger })

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

  let failure: unknown
  try {
    // start() mints the run id synchronously — bind the logger before awaiting the run,
    // so every CLI log line lands in .mt/runs/<runId>/run.log
    const startPromise = runner.start()
    const runId = runner.getRunId()
    if (runId) logger.setRunId(runId)
    const runContext = await startPromise
    logger.info(`Pipeline completed successfully (runId: ${runContext.runId})`)
    console.log(`\n✅ Pipeline complete. Run ID: ${runContext.runId}`)
  } catch (error) {
    failure = error
    const errorMessage = error instanceof Error ? error.message : String(error)
    const hint = nativeAddonHint(error) || packageResolutionHint(error)
    logger.error(`Pipeline failed: ${errorMessage}`)
    console.error(`\n❌ Pipeline failed: ${errorMessage}${hint}`)
    await runSwallowingHookErrors(globalContext, 'error', { pipelineName, logger })
  }

  // scripts.end runs on success AND failure; an end-hook error must not mask the outcome.
  await runSwallowingHookErrors(globalContext, 'end', { pipelineName, logger })

  // scripts.exit runs once as the process is about to leave, after end.
  await runSwallowingHookErrors(globalContext, 'exit', { pipelineName, logger })

  // Make sure the per-run log file is fully written before the process exits
  await logger.flush()

  if (failure !== undefined) process.exit(1)
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
 * Load a pipeline module from a file path.
 * Uses dynamic import (tsx/jiti compatible).
 */
async function loadPipeline(filePath: string, name?: string): Promise<Pipeline> {
  const resolvedPath = resolve(process.cwd(), filePath)
  const mod = await importPipelineModule(resolvedPath)
  const pipeline = (name ? mod[name] : (mod.default ?? mod.pipeline)) as Pipeline | undefined

  if (!pipeline || typeof pipeline.id !== 'string') {
    const hint = name ? ` (named export '${name}' not found or invalid)` : ''
    throw new Error(
      `Invalid pipeline module: ${filePath}. Expected ${name ? `export const ${name}` : 'default export'} from definePipeline().${hint}`,
    )
  }

  return pipeline as Pipeline
}
