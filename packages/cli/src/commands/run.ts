import { join } from 'node:path'
import { Runner } from '@mt/core'
import type { GlobalContext, Pipeline } from '@mt/core'
import { DuplexLogger } from '../utils/logger.js'

/**
 * `mt run <pipelineFile>` — execute a pipeline.
 *
 * Usage: mt run ./pipelines/example.ts
 */
export async function runCommand(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error('Usage: mt run <pipeline.ts>')
    console.error('  Execute a pipeline file (foreground; logs to console + .mt)')
    process.exit(1)
  }

  const pipelineFile = args[0] as string
  const projectRoot = process.cwd()

  // Load pipeline module
  const pipeline = await loadPipeline(pipelineFile)

  // Build global context from mt.json
  const globalContext = await buildGlobalContext(projectRoot)

  // Create logger
  const logger = new DuplexLogger(join(projectRoot, '.mt', 'runs'))

  logger.info(`Starting pipeline: ${pipeline.id}`)
  logger.info(`Pipeline file: ${pipelineFile}`)

  // Create and start runner
  const runner = new Runner(pipeline, globalContext)

  process.on('SIGINT', async () => {
    logger.warn('SIGINT received: exiting...')
    console.log(`\n\u274c Pipeline aborted. Run ID: ${runner.getRunId()}`)
    process.exit(0)
  })

  try {
    const runContext = await runner.start()
    logger.info(`Pipeline completed successfully (runId: ${runContext.runId})`)
    console.log(`\n\u2705 Pipeline complete. Run ID: ${runContext.runId}`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`Pipeline failed: ${errorMessage}`)
    console.error(`\n\u274c Pipeline failed: ${errorMessage}`)
    process.exit(1)
  }
}

/**
 * Load a pipeline module from a file path.
 * Uses dynamic import (tsx/jiti compatible).
 */
async function loadPipeline(filePath: string): Promise<Pipeline> {
  const resolvedPath = join(process.cwd(), filePath)
  const mod = await import(resolvedPath)
  const pipeline = mod.default ?? mod.pipeline

  if (!pipeline || typeof pipeline.id !== 'string') {
    throw new Error(
      `Invalid pipeline module: ${filePath}. Expected default export from definePipeline().`,
    )
  }

  return pipeline as Pipeline
}

/**
 * Build a GlobalContext from mt.json if it exists.
 */
async function buildGlobalContext(projectRoot: string): Promise<GlobalContext> {
  const { readFile } = await import('node:fs/promises')
  const configPath = join(projectRoot, 'mt.json')

  try {
    const configContent = await readFile(configPath, 'utf-8')
    const config = JSON.parse(configContent) as Record<string, unknown>

    const project = config.project as Record<string, unknown> | undefined
    const defaults = config.defaults as Record<string, unknown> | undefined
    const retryDef = defaults?.retry as Record<string, unknown> | undefined

    return {
      project: {
        name: (project?.name as string) ?? 'unknown',
        root: projectRoot,
      },
      defaults: {
        retry: {
          max: (retryDef?.max as number) ?? 3,
          backoffMs: (retryDef?.backoffMs as number) ?? 1000,
          strategy: (retryDef?.strategy as 'fixed' | 'linear' | 'exp') ?? 'exp',
        },
        onError: (defaults?.onError as 'fail-run' | 'skip-item' | 'dead-letter') ?? 'fail-run',
        concurrency: (defaults?.concurrency as number) ?? 4,
      },
      env: {},
    }
  } catch {
    // No mt.json — use defaults
    return {
      project: {
        name: 'unknown',
        root: projectRoot,
      },
      defaults: {
        retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
        onError: 'fail-run',
        concurrency: 4,
      },
      env: {},
    }
  }
}
