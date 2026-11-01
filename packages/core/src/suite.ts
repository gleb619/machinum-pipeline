import { loadGlobalContext } from './config.js'
import type { GlobalContext } from './contexts.js'
import { Runner } from './engine/runner.js'
import type { Pipeline, RunnerOptions } from './types.js'

export type PipelineSuiteMode = 'sync' | 'parallel'

export interface PipelineSuiteOptions {
  id?: string
  mode?: PipelineSuiteMode
}

export interface SuiteRunOptions extends RunnerOptions {
  /** Called once per pipeline after its Runner has minted a run id, before the run is awaited. */
  onRunner?: (runner: Runner, pipeline: Pipeline) => void
}

export interface PipelineSuite {
  readonly kind: 'pipeline-suite'
  readonly id: string
  readonly pipelines: readonly Pipeline[]
  readonly mode: PipelineSuiteMode
  /** Return a new suite with the same id/pipelines and sequential mode. */
  sync(): PipelineSuite
  /** Return a new suite with the same id/pipelines and parallel mode. */
  parallel(): PipelineSuite
  /** Run every pipeline in this process, sequentially or in parallel depending on `mode`. */
  run(globalContext?: GlobalContext, options?: SuiteRunOptions): Promise<void>
}

export function defineSuite(
  pipelines: readonly Pipeline[],
  options?: PipelineSuiteOptions,
): PipelineSuite {
  if (!Array.isArray(pipelines) || pipelines.length === 0) {
    throw new TypeError('defineSuite: pipelines must be a non-empty array')
  }

  for (const [index, pipeline] of pipelines.entries()) {
    if (!isPipeline(pipeline)) {
      throw new TypeError(
        `defineSuite: pipelines[${index}] must be an object with a string id and a steps array`,
      )
    }
  }

  const suitePipelines = [...pipelines]
  const id = options?.id ?? 'pipeline-suite'
  const mode = options?.mode ?? 'sync'

  const build = (suiteMode: PipelineSuiteMode): PipelineSuite => ({
    kind: 'pipeline-suite',
    id,
    pipelines: suitePipelines,
    mode: suiteMode,
    sync: () => build('sync'),
    parallel: () => build('parallel'),
    async run(globalContext?: GlobalContext, options?: SuiteRunOptions): Promise<void> {
      const ctx = globalContext ?? (await loadGlobalContext(process.cwd()))

      const runOne = async (pipeline: Pipeline): Promise<void> => {
        const runner = new Runner(pipeline, ctx, options)
        const started = runner.start()
        options?.onRunner?.(runner, pipeline)
        await started
      }

      if (suiteMode === 'parallel') {
        await Promise.all(suitePipelines.map(runOne))
        return
      }

      for (const pipeline of suitePipelines) {
        await runOne(pipeline)
      }
    },
  })

  return build(mode)
}

export function isPipeline(value: unknown): value is Pipeline {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Partial<Pipeline>
  return typeof candidate.id === 'string' && Array.isArray(candidate.steps)
}

export function isPipelineSuite(value: unknown): value is PipelineSuite {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Partial<PipelineSuite>
  return (
    candidate.kind === 'pipeline-suite' &&
    typeof candidate.id === 'string' &&
    Array.isArray(candidate.pipelines) &&
    typeof candidate.run === 'function'
  )
}
