import { join, relative, resolve } from 'node:path'
import {
  Runner,
  Store,
  importPipelineModule,
  loadGlobalContext,
  nativeAddonHint,
  packageResolutionHint,
} from '@mt/core'
import type { Pipeline, RunStateData } from '@mt/core'
import { DuplexLogger } from '../utils/logger.js'

/**
 * `mt resume <runId> [pipeline.ts]` — resume a previous run.
 *
 * The pipeline file recorded in `.mt/runs/<runId>/state.json` is used when no file
 * argument is given, so the operator does not have to remember what started the run.
 */
export async function resumeCommand(args: string[]): Promise<void> {
  const [runId, pipelineFileArg] = args
  if (!runId) {
    console.error('Usage: mt resume <runId> [pipeline.ts]')
    process.exit(1)
  }

  const projectRoot = process.cwd()

  // Build global context
  const globalContext = await loadGlobalContext(projectRoot)

  // Resolve pipeline file: explicit arg wins, otherwise read it from the run's state.json
  let pipelineFile = pipelineFileArg
  let pipelineName: string | undefined
  if (!pipelineFile) {
    const store = new Store(join(projectRoot, '.mt'))
    if (!(await store.exists('runs', runId, 'state.json'))) {
      throw new Error(
        `No state found for run '${runId}' (expected .mt/runs/${runId}/state.json). Pass the pipeline file explicitly: mt resume <runId> <pipeline.ts>`,
      )
    }
    const state = await store.readJson<RunStateData>('runs', runId, 'state.json')
    if (!state.pipelineFile) {
      throw new Error(
        `Run '${runId}' was started by an older version and has no pipelineFile in state.json. ` +
          `Pass the pipeline file explicitly: mt resume ${runId} <pipeline.ts>`,
      )
    }
    pipelineFile = state.pipelineFile
    pipelineName = state.pipelineName
  }

  // Load pipeline
  const pipeline = await loadPipeline(pipelineFile, pipelineName)

  // Initialize Runner (re-record provenance so later pauses/resumes keep it)
  const pipelineFileRel = relative(projectRoot, resolve(projectRoot, pipelineFile))
  const runner = new Runner(pipeline, globalContext, {
    pipelineFile: pipelineFileRel,
    pipelineName,
  })

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
async function loadPipeline(filePath: string, name?: string): Promise<Pipeline> {
  const resolvedPath = resolve(process.cwd(), filePath)
  const mod = await importPipelineModule(resolvedPath)
  const pipeline = (name ? mod[name] : (mod.default ?? mod.pipeline)) as Pipeline | undefined
  if (!pipeline || typeof pipeline.id !== 'string') {
    const hint = name ? ` (named export '${name}' not found or invalid)` : ''
    throw new Error(`Invalid pipeline module: ${filePath}.${hint}`)
  }
  return pipeline
}
