import { join } from 'node:path'
import { Runner } from '@mt/core'
import type { GlobalContext, Pipeline } from '@mt/core'
import { createError, defineEventHandler, readBody } from 'h3'

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
    pipelineModule = await import(resolvedPath)
  } catch (_err) {
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
    env: process.env as Record<string, string>,
  }

  const runner = new Runner(pipeline, globalContext)

  // Fire-and-forget: start the run in background
  runner.start().catch((err) => {
    console.error(`[run:${runner.getRunId()}] Background run failed:`, err)
  })

  return { runId: runner.getRunId() }
})
