import { access } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Pipeline } from '@mt/core'
import {
  Runner,
  createConsoleLogger,
  importPipelineModule,
  isNativeAddonError,
  isPackageResolutionError,
  loadGlobalContext,
  nativeAddonHint,
  packageResolutionHint,
} from '@mt/core'
import { createError, defineEventHandler, readBody } from 'h3'
import { PathOutsideRootError, resolveInsideRoot } from '../../../utils/resolve-inside-root.js'
import { projectRootFor } from '../../../utils/run-dir.js'
import {
  attachProjectRunner,
  claimProjectRun,
  registerRunner,
  releaseProjectRun,
  removeRunner,
} from '../../../utils/runner-registry.js'

interface StartRunBody {
  pipeline: string
  projectId?: string
  pipelineName?: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<StartRunBody>(event)
  if (!body?.pipeline) {
    throw createError({ statusCode: 400, statusMessage: 'Missing pipeline path' })
  }

  const projectRoot = projectRootFor(event, body.projectId)
  const declaredPath = body.pipeline

  const claimed = body.projectId !== undefined && claimProjectRun(body.projectId)
  if (body.projectId !== undefined && !claimed) {
    throw createError({
      statusCode: 409,
      statusMessage: `A run is already active for project '${body.projectId}'`,
    })
  }

  try {
    let resolvedPath: string
    try {
      resolvedPath = resolveInsideRoot(projectRoot, declaredPath)
    } catch (err) {
      if (err instanceof PathOutsideRootError) {
        throw createError({ statusCode: 400, statusMessage: 'Pipeline path outside project' })
      }
      throw err
    }

    try {
      await access(resolvedPath)
    } catch {
      throw createError({ statusCode: 404, statusMessage: `Pipeline not found: ${declaredPath}` })
    }

    let pipelineModule: Record<string, unknown>
    try {
      pipelineModule = (await importPipelineModule(resolvedPath)) as Record<string, unknown>
    } catch (err) {
      if (isNativeAddonError(err) || isPackageResolutionError(err)) {
        const hint = nativeAddonHint(err) || packageResolutionHint(err)
        throw createError({
          statusCode: 400,
          statusMessage: `Pipeline cannot be loaded: ${declaredPath}${hint}`,
        })
      }
      const message = err instanceof Error ? err.message : String(err)
      throw createError({
        statusCode: 500,
        statusMessage: `Pipeline failed to load: ${declaredPath}: ${message}`,
      })
    }

    const selected = body.pipelineName
      ? pipelineModule[body.pipelineName]
      : (pipelineModule.default ?? pipelineModule.pipeline)
    if (!isPipelineLike(selected)) {
      throw createError({
        statusCode: 400,
        statusMessage: body.pipelineName
          ? `Invalid pipeline module: ${declaredPath} (named export '${body.pipelineName}' not found or invalid)`
          : `Invalid pipeline module: ${declaredPath} (must export default definePipeline(...))`,
      })
    }

    const globalContext = await loadGlobalContext(projectRoot)

    const runner = new Runner(selected, globalContext, {
      pipelineFile: relative(projectRoot, resolvedPath),
      pipelineName: body.pipelineName,
    })

    // Fire-and-forget: start the run in background
    const running = runner.start()
    // start() mints the runId before its first await, so it is readable here
    const runId = runner.getRunId()
    if (!runId) {
      throw createError({ statusCode: 500, statusMessage: 'Runner did not mint a run id' })
    }
    registerRunner(runId, runner)
    if (body.projectId !== undefined) attachProjectRunner(body.projectId, runner)

    const logger = createConsoleLogger()
    running
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`[run:${runId}] Background run failed: ${message}`)
      })
      .finally(() => {
        // done/failed: pause/resume must not reach a Runner that can no longer run
        removeRunner(runId)
        if (body.projectId !== undefined) releaseProjectRun(body.projectId, runner)
      })

    // The run id is minted before the first persist; wait for the event log so the
    // client's first SSE connect does not race the file creation.
    await waitForFile(join(projectRoot, '.mt', 'runs', runId, 'events.jsonl'))

    return { runId, projectId: body.projectId }
  } catch (err) {
    if (body.projectId !== undefined && claimed) releaseProjectRun(body.projectId)
    throw err
  }
})

function isPipelineLike(value: unknown): value is Pipeline {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    Array.isArray((value as { steps?: unknown }).steps)
  )
}

async function waitForFile(path: string, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20))
    }
  }
}
