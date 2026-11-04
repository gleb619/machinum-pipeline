import { randomUUID } from 'node:crypto'
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
  normalizeSyncPath,
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
import {
  attachWorkerRun,
  dispatchWorkerSignal,
  findWorkerByTags,
  getWorker,
} from '../../../utils/worker-registry.js'
import { createWorkerRunRecord } from '../../../utils/worker-run-record.js'

interface StartRunBody {
  pipeline: string
  projectId?: string
  pipelineName?: string
  /** Route to one worker by id. */
  worker?: string
  /** Route to the first online worker carrying every tag. */
  tags?: string[]
}

export default defineEventHandler(async (event) => {
  const body = await readBody<StartRunBody>(event)
  if (!body?.pipeline) {
    throw createError({ statusCode: 400, statusMessage: 'Missing pipeline path' })
  }

  const projectRoot = projectRootFor(event, body.projectId)
  const declaredPath = body.pipeline

  if (body.worker !== undefined || body.tags !== undefined) {
    return dispatchToWorker(body, projectRoot)
  }

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

/**
 * Worker routing (T205): main mints the run id, creates the run record, then sends the
 * `run` signal. The worker child executes the pipeline; events arrive through the
 * events ingest endpoint, so `mt ls runs` / `mt inspect` / webui work unchanged.
 */
async function dispatchToWorker(
  body: StartRunBody,
  projectRoot: string,
): Promise<{ runId: string; workerId: string }> {
  const worker =
    body.worker === undefined
      ? await findWorkerByTags(projectRoot, body.tags ?? [])
      : await getWorker(projectRoot, body.worker)
  if (worker === undefined || worker.status === 'lost') {
    throw createError({
      statusCode: 409,
      statusMessage:
        body.worker === undefined
          ? `No online worker matches tags: ${(body.tags ?? []).join(',')}`
          : `Worker is not online: ${body.worker}`,
    })
  }
  if (body.tags?.some((tag) => !worker.tags.includes(tag))) {
    throw createError({
      statusCode: 409,
      statusMessage: `Worker '${worker.id}' does not carry the requested tags`,
    })
  }

  const pipeline = normalizeSyncPath(body.pipeline)
  if (pipeline === undefined) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid pipeline path' })
  }
  try {
    await access(join(projectRoot, ...pipeline.split('/')))
  } catch {
    throw createError({ statusCode: 404, statusMessage: `Pipeline not found: ${body.pipeline}` })
  }

  const runId = randomUUID()
  await createWorkerRunRecord(projectRoot, {
    runId,
    pipeline,
    ...(body.pipelineName === undefined ? {} : { pipelineName: body.pipelineName }),
  })
  await attachWorkerRun(projectRoot, worker.id, runId)
  await dispatchWorkerSignal(projectRoot, worker.id, 'run', {
    runId,
    pipeline,
    ...(body.pipelineName === undefined ? {} : { pipelineName: body.pipelineName }),
  })
  return { runId, workerId: worker.id }
}

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
