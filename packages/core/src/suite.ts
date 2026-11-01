import { loadGlobalContext } from './config.js'
import type { GlobalContext } from './contexts.js'
import { Runner } from './engine/runner.js'
import type { Pipeline, RunnerOptions } from './types.js'

export interface PipelineSuiteOptions {
  id?: string
}

export interface PipelineSuite {
  readonly kind: 'pipeline-suite'
  readonly id: string
  readonly pipelines: readonly Pipeline[]
  /** Run every pipeline sequentially, in declaration order, in this process. */
  run(globalContext?: GlobalContext, options?: RunnerOptions): Promise<void>
}

export function defineSuite(
  pipelines: readonly Pipeline[],
  options?: PipelineSuiteOptions,
): PipelineSuite {
  if (!Array.isArray(pipelines) || pipelines.length === 0) {
    throw new TypeError('defineSuite: pipelines must be a non-empty array')
  }

  for (const [index, pipeline] of pipelines.entries()) {
    if (
      typeof pipeline !== 'object' ||
      pipeline === null ||
      typeof (pipeline as { id?: unknown }).id !== 'string'
    ) {
      throw new TypeError(`defineSuite: pipelines[${index}] must be an object with a string id`)
    }
  }

  const suitePipelines = [...pipelines]

  return {
    kind: 'pipeline-suite',
    id: options?.id ?? 'pipeline-suite',
    pipelines: suitePipelines,
    async run(globalContext?: GlobalContext, runnerOptions?: RunnerOptions): Promise<void> {
      const ctx = globalContext ?? (await loadGlobalContext(process.cwd()))
      for (const pipeline of suitePipelines) {
        await new Runner(pipeline, ctx, runnerOptions).start()
      }
    },
  }
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
