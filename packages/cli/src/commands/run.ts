import { join, relative, resolve } from 'node:path'
import {
  Runner,
  importPipelineModule,
  loadGlobalContext,
  nativeAddonHint,
  packageResolutionHint,
} from '@mt/core'
import type { Pipeline } from '@mt/core'

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
  const globalContext = await loadGlobalContext(projectRoot)

  // Create logger
  const logger = new DuplexLogger(join(projectRoot, '.mt', 'runs'))

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
    const hint = nativeAddonHint(error) || packageResolutionHint(error)
    logger.error(`Pipeline failed: ${errorMessage}`)
    console.error(`\n❌ Pipeline failed: ${errorMessage}${hint}`)
    process.exit(1)
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
