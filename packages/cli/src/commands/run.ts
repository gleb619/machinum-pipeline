import { join } from 'node:path'
import { Runner } from '@mt/core'
import type { GlobalContext, Pipeline } from '@mt/core'

// Ensure built-in sources/targets are registered before resolving URIs
import '@mt/waypoint'

import { DuplexLogger } from '../utils/logger.js'

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
  const globalContext = await buildGlobalContext(projectRoot)

  // Create logger
  const logger = new DuplexLogger(join(projectRoot, '.mt', 'runs'))

  logger.info(`Starting pipeline: ${pipeline.id}`)
  logger.info(`Pipeline file: ${pipelineFile}`)

  // Create and start runner
  const runner = new Runner(pipeline, globalContext)

  process.on('SIGINT', async () => {
    logger.warn('SIGINT received: pausing pipeline...')
    await runner.pause()
    console.log(`\n⏸ Pipeline paused. Run ID: ${runner.getRunId()}`)
    console.log(`  Resume with: mt resume ${runner.getRunId()}`)
    process.exit(0)
  })

  try {
    const runContext = await runner.start()
    logger.info(`Pipeline completed successfully (runId: ${runContext.runId})`)
    console.log(`\n✅ Pipeline complete. Run ID: ${runContext.runId}`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`Pipeline failed: ${errorMessage}`)
    console.error(`\n❌ Pipeline failed: ${errorMessage}`)
    process.exit(1)
  }
}

/**
 * Load a pipeline module from a file path.
 * Uses dynamic import (tsx/jiti compatible).
 */
async function loadPipeline(filePath: string, name?: string): Promise<Pipeline> {
  const resolvedPath = join(process.cwd(), filePath)
  const mod = await import(resolvedPath)
  const pipeline = name ? (mod[name] as Pipeline | undefined) : (mod.default ?? mod.pipeline)

  if (!pipeline || typeof pipeline.id !== 'string') {
    const hint = name ? ` (named export '${name}' not found or invalid)` : ''
    throw new Error(
      `Invalid pipeline module: ${filePath}. Expected ${name ? `export const ${name}` : 'default export'} from definePipeline().${hint}`,
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
    const settings = (config.settings as Record<string, unknown>) ?? {}

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
      settings,
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
      settings: {},
      env: {},
    }
  }
}
