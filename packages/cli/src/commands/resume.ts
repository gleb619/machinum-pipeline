import { join, resolve } from 'node:path'
import {
  Runner,
  importPipelineModule,
  loadGlobalContext,
  nativeAddonHint,
  packageResolutionHint,
} from '@mt/core'
import type { Pipeline } from '@mt/core'
import { DuplexLogger } from '../utils/logger.js'

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
  const globalContext = await loadGlobalContext(projectRoot)

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
    console.log(`\n✅ Pipeline resumed and complete. Run ID: ${runContext.runId}`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const hint = nativeAddonHint(error) || packageResolutionHint(error)
    logger.error(`Pipeline resume failed: ${errorMessage}`)
    console.error(`\n❌ Pipeline resume failed: ${errorMessage}${hint}`)
    process.exit(1)
  }
}

/**
 * Load a pipeline module from a file path.
 */
async function loadPipeline(filePath: string): Promise<Pipeline> {
  const resolvedPath = resolve(process.cwd(), filePath)
  const mod = await importPipelineModule(resolvedPath)
  const pipeline = (mod.default ?? mod.pipeline) as Pipeline | undefined
  if (!pipeline || typeof pipeline.id !== 'string') {
    throw new Error(`Invalid pipeline module: ${filePath}.`)
  }
  return pipeline
}
