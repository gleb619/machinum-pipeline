import { join } from 'node:path'
import { Runner } from '@mt/core'
import type { GlobalContext } from '@mt/core'
import { DuplexLogger } from '../utils/logger.js'
import { readFile } from 'node:fs/promises'

/**
 * `mt resume <runId>` — resume a previous run.
 */
export async function resumeCommand(args: string[]): Promise<void> {
  if (args.length < 2) {
    console.error('Usage: mt resume <runId> <pipeline.ts>')
    process.exit(1)
  }

  const [runId, pipelineFile] = args
  if (!runId || !pipelineFile) {
    throw new Error('Usage: mt resume <runId> <pipeline.ts>')
  }
  const projectRoot = process.cwd()

  // Build global context
  const globalContext = await buildGlobalContext(projectRoot)

  // Load pipeline
  const pipeline = await loadPipeline(pipelineFile)

  // Initialize Runner
  const runner = new Runner(pipeline, globalContext)

  // Create logger
  const logger = new DuplexLogger(join(projectRoot, '.mt', 'runs'))

  logger.info(`Resuming pipeline: ${pipeline.id}, runId: ${runId}`)

  try {
    const runContext = await runner.resume(runId)
    logger.info(`Pipeline resumed and completed successfully (runId: ${runContext.runId})`)
    console.log(`\n\u2705 Pipeline resumed and complete. Run ID: ${runContext.runId}`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`Pipeline resume failed: ${errorMessage}`)
    console.error(`\n\u274c Pipeline resume failed: ${errorMessage}`)
    process.exit(1)
  }
}

/**
 * Load a pipeline module from a file path.
 */
async function loadPipeline(filePath: string): Promise<any> {
  const resolvedPath = join(process.cwd(), filePath)
  const mod = await import(resolvedPath)
  const pipeline = mod.default ?? mod.pipeline
  if (!pipeline || typeof pipeline.id !== 'string') {
    throw new Error(`Invalid pipeline module: ${filePath}.`)
  }
  return pipeline
}

/**
 * Build a GlobalContext from mt.json if it exists.
 */
async function buildGlobalContext(projectRoot: string): Promise<GlobalContext> {
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
