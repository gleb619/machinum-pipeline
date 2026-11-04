import { join, relative, resolve } from 'node:path'
import {
  Runner,
  Store,
  annotate,
  importPipelineModule,
  isPipeline,
  isPipelineSuite,
  loadGlobalContext,
  nativeAddonHint,
  packageResolutionHint,
  useCase,
} from '@mt/core'
import type { Pipeline, PipelineSuite, RunStateData } from '@mt/core'
import { DuplexLogger } from '../utils/logger.js'
import { type RemoteRunFlags, resumeRemotePipeline } from '../utils/remote-run.js'
import { RunReporter } from '../utils/run-report.js'
import { runLifecycleScript } from './utils/lifecycle.js'

export interface ResumeCommandOptions {
  runId?: string
  pipelineFile?: string
  remote?: RemoteRunFlags
  /** Hidden worker-child mode: post events to this main `mt serve`. */
  reportTo?: string
}

/** Parse `mt resume` flags; `--remote` switches to remote re-attach mode. */
export function parseResumeArgs(args: readonly string[]): ResumeCommandOptions {
  const options: ResumeCommandOptions = {}
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === '--remote' || arg.startsWith('--remote=')) {
      const remote = options.remote ?? {}
      options.remote = remote
      const inline = arg.startsWith('--remote=') ? arg.slice('--remote='.length) : undefined
      if (inline !== undefined && inline !== '') {
        remote.url = inline
      } else {
        const next = args[index + 1]
        if (next !== undefined && /^https?:\/\//.test(next)) {
          remote.url = next
          index++
        }
      }
    } else if (arg === '--token-ref' || arg.startsWith('--token-ref=')) {
      const inline = arg.startsWith('--token-ref=') ? arg.slice('--token-ref='.length) : undefined
      const value = inline ?? args[++index]
      if (value === undefined || value === '') throw new Error('--token-ref requires a value')
      options.remote = { ...(options.remote ?? {}), tokenRef: value }
    } else if (arg === '--allow-version-mismatch') {
      options.remote = { ...(options.remote ?? {}), allowVersionMismatch: true }
    } else if (arg === '--report-to' || arg.startsWith('--report-to=')) {
      const inline = arg.startsWith('--report-to=') ? arg.slice('--report-to='.length) : undefined
      const value = inline ?? args[++index]
      if (value === undefined || value === '') throw new Error('--report-to requires a value')
      options.reportTo = value
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown resume option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  options.runId = positional[0]
  options.pipelineFile = positional[1]
  return options
}

/**
 * `mt resume <runId> [pipeline.ts]` — resume a previous run.
 *
 * The pipeline file recorded in `.mt/runs/<runId>/state.json` is used when no file
 * argument is given, so the operator does not have to remember what started the run.
 * A run always belongs to one pipeline — suites cannot be resumed as a whole.
 */
export async function resumeCommand(args: string[]): Promise<void> {
  const parsed = parseResumeArgs(args)
  const runId = parsed.runId
  const pipelineFileArg = parsed.pipelineFile
  if (!runId) {
    console.error(
      'Usage: mt resume <runId> [pipeline.ts] [--remote [url]] [--token-ref <ENV_OR_REF>]',
    )
    process.exit(1)
  }

  const projectRoot = process.cwd()

  if (parsed.remote !== undefined) {
    const logger = new DuplexLogger(join(projectRoot, '.mt', 'runs'))
    const artifactIntervalMs = Number(process.env.MT_REMOTE_ARTIFACT_INTERVAL_MS)
    let outcome: Awaited<ReturnType<typeof resumeRemotePipeline>>
    try {
      outcome = await resumeRemotePipeline({
        projectRoot,
        logger,
        remote: parsed.remote,
        runId,
        ...(Number.isFinite(artifactIntervalMs) && artifactIntervalMs > 0
          ? { artifactIntervalMs }
          : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`Remote resume failed: ${message}`)
      await logger.flush()
      process.exit(1)
    }
    await logger.flush()
    if (outcome.exitCode !== 0) process.exit(outcome.exitCode)
    return
  }

  // Build global context
  const globalContext = await loadGlobalContext(projectRoot)

  // Always read state.json: it carries the pipeline id, plus file/name provenance.
  const store = new Store(join(projectRoot, '.mt'))
  if (!(await store.exists('runs', runId, 'state.json'))) {
    throw new Error(
      `No state found for run '${runId}' (expected .mt/runs/${runId}/state.json). Cannot resume without the recorded pipeline id.`,
    )
  }
  const state = await store.readJson<RunStateData>('runs', runId, 'state.json')
  if (!state.pipelineId) {
    throw new Error(
      `Run '${runId}' has no pipelineId in state.json. Pass the pipeline file explicitly: mt resume ${runId} <pipeline.ts>`,
    )
  }

  const pipelineFile = pipelineFileArg ?? state.pipelineFile
  if (!pipelineFile) {
    throw new Error(
      `Run '${runId}' was started by an older version and has no pipelineFile in state.json. ` +
        `Pass the pipeline file explicitly: mt resume ${runId} <pipeline.ts>`,
    )
  }
  const pipelineName = state.pipelineName

  // Load the pipeline that owns this run (possibly nested in a suite export)
  const pipeline = await loadPipeline(pipelineFile, state.pipelineId, pipelineName)

  // Initialize Runner (re-record provenance so later pauses/resumes keep it)
  const pipelineFileRel = relative(projectRoot, resolve(projectRoot, pipelineFile))
  const runner = new Runner(pipeline, globalContext, {
    pipelineFile: pipelineFileRel,
    pipelineName,
  })

  // Create logger — the run id is known up front, so logs go straight to the run's log
  const logger = new DuplexLogger(join(projectRoot, '.mt', 'runs'))
  logger.setRunId(runId)
  const reporter =
    parsed.reportTo === undefined
      ? undefined
      : new RunReporter({
          mainUrl: parsed.reportTo,
          token: process.env.MT_WORKER_MAIN_TOKEN,
          runId,
          eventsPath: join(projectRoot, '.mt', 'runs', runId, 'events.jsonl'),
          logger,
        })

  logger.info(`Resuming pipeline: ${pipeline.id}, runId: ${runId}`)
  await reporter?.start()

  // Lifecycle hook: scripts.resume before resuming. A resume-hook error is logged but does not stop the resume.
  await runSwallowingHookErrors(globalContext, 'resume', { pipelineName, logger })

  try {
    const runContext = await runner.resume(runId)
    logger.info(`Pipeline resumed and complete. Run ID: ${runContext.runId}`)
    await reporter?.flush()
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const hint = nativeAddonHint(error) || packageResolutionHint(error)
    logger.error(`Pipeline resume failed: ${errorMessage}${hint}`)
    await reporter?.flush()
    await runSwallowingHookErrors(globalContext, 'error', { pipelineName, logger })
    // Make sure the per-run log file is fully written before the process exits
    await logger.flush()
    process.exit(1)
  }

  await logger.flush()
}

annotate(
  resumeCommand,
  useCase('UC006', {
    name: 'Resume a paused/failed Run',
    description: 'Continue a Run from the last completed checkpoint.',
  }),
)

/**
 * Run a lifecycle hook and log hook errors without letting them change the
 * command's outcome.
 */
async function runSwallowingHookErrors(
  ctx: Awaited<ReturnType<typeof loadGlobalContext>>,
  name: import('./utils/lifecycle.js').LifecycleHookName,
  options: { pipelineName?: string; logger: Pick<import('@mt/core').Logger, 'info' | 'warn'> },
): Promise<void> {
  try {
    await runLifecycleScript(ctx, name, options)
  } catch (hookError) {
    const hookMessage = hookError instanceof Error ? hookError.message : String(hookError)
    options.logger.warn(`${name} hook failed: ${hookMessage}`)
  }
}

/**
 * Load the pipeline that owns a run.
 *
 * A named export is resolved first. Otherwise the module exports are searched for
 * a pipeline with `pipelineId`, including pipelines nested in suite exports. A
 * suite itself cannot be resumed — only the individual pipeline run can.
 */
async function loadPipeline(
  filePath: string,
  pipelineId: string,
  name?: string,
): Promise<Pipeline> {
  const resolvedPath = resolve(process.cwd(), filePath)
  const mod = (await importPipelineModule(resolvedPath)) as Record<string, unknown>

  if (name) {
    const selected = mod[name]
    if (isPipelineSuite(selected)) {
      const nested = findInSuite(selected, pipelineId)
      if (nested) return nested
      throw new Error(
        `Run '${pipelineId}' belongs to a pipeline in suite '${selected.id}', but export '${name}' does not contain it. A suite cannot be resumed as a whole; select the pipeline export that owns this run.`,
      )
    }
    if (isPipeline(selected) || isLegacyPipeline(selected)) return selected

    throw new Error(
      `Invalid pipeline module: ${filePath}. (named export '${name}' not found or invalid)`,
    )
  }

  for (const value of Object.values(mod)) {
    if (isPipeline(value) && value.id === pipelineId) return value
  }
  for (const value of Object.values(mod)) {
    if (isPipelineSuite(value)) {
      const nested = findInSuite(value, pipelineId)
      if (nested) return nested
    }
  }
  for (const value of Object.values(mod)) {
    if (isLegacyPipeline(value) && value.id === pipelineId) return value
  }

  const suiteIds = Object.values(mod)
    .filter(isPipelineSuite)
    .map((suite) => suite.id)
  if (suiteIds.length > 0) {
    throw new Error(
      `Run '${pipelineId}' belongs to a pipeline in suite ${suiteIds.map((id) => `'${id}'`).join(', ')}, but that pipeline was not found in the module exports. A suite cannot be resumed as a whole; select the pipeline export that owns this run.`,
    )
  }

  throw new Error(`Cannot find pipeline '${pipelineId}' among exports of ${filePath}.`)
}

function findInSuite(suite: PipelineSuite, pipelineId: string): Pipeline | undefined {
  return suite.pipelines.find((pipeline) => pipeline.id === pipelineId)
}

function isLegacyPipeline(value: unknown): value is Pipeline {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  )
}
