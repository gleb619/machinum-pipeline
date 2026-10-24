import { join } from 'node:path'
import {
  Runner,
  importPipelineModule,
  isNativeAddonError,
  isPackageResolutionError,
  nativeAddonHint,
  packageResolutionHint,
} from '@mt/core'
import type { GlobalContext, Pipeline } from '@mt/core'
import { createError, defineEventHandler, readBody } from 'h3'
import { registerRunner, removeRunner } from '../../../utils/runner-registry.js'

interface StartRunBody {
  pipeline: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<StartRunBody>(event)
  if (!body?.pipeline) {
    throw createError({ statusCode: 400, statusMessage: 'Missing pipeline path' })
  }

  const projectRoot = process.cwd()
  const declaredPath = body.pipeline
  const resolvedPath = join(projectRoot, declaredPath)

  let pipelineModule: { default?: Pipeline }
  try {
    pipelineModule = await importPipelineModule(resolvedPath)
  } catch (err) {
    if (isNativeAddonError(err) || isPackageResolutionError(err)) {
      const hint = nativeAddonHint(err) || packageResolutionHint(err)
      throw createError({
        statusCode: 400,
        statusMessage: `Pipeline cannot be loaded: ${declaredPath}${hint}`,
      })
    }
    throw createError({
      statusCode: 404,
      statusMessage: `Pipeline not found: ${declaredPath}`,
    })
  }

  const pipeline = pipelineModule.default
  if (!pipeline || typeof pipeline.id !== 'string' || !Array.isArray(pipeline.steps)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Invalid pipeline module: ${declaredPath} (must export default definePipeline(...))`,
    })
  }

  const globalContext: GlobalContext = {
    project: {
      name: 'mt-project',
      root: projectRoot,
    },
    defaults: {
      retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
      onError: 'fail-run',
      concurrency: 5,
    },
    settings: {},
    env: process.env as Record<string, string>,
  }

  const runner = new Runner(pipeline, globalContext)

  // Fire-and-forget: start the run in background
  const running = runner.start()
  // start() mints the runId before its first await, so it is readable here
  const runId = runner.getRunId()
  if (runId) registerRunner(runId, runner)

  running
    .catch((err) => {
      console.error(`[run:${runner.getRunId()}] Background run failed:`, err)
    })
    .finally(() => {
      // done/failed: pause/resume must not reach a Runner that can no longer run
      if (runId) removeRunner(runId)
    })

  return { runId }
})
