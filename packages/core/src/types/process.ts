import type { Runner } from '../engine/runner.js'
import type { ProcessMode } from '../process.js'
import type { Pipeline, RunnerOptions } from '../types.js'
import type { GlobalContext } from './contexts.js'
/**
 * A runnable group of pipelines created by `defineProcess(pipelines, { id? })`.
 * One Runner/run id per pipeline, all sharing one `GlobalContext`. `mode`
 * defaults to `'sync'` (sequential, declaration order, stops on the first
 * failure); `.parallel(true)` returns a parallel-mode copy. Only present on
 * ProcessBuilders created with a pipelines array — `kind` is `undefined` for
 * plain `defineProcess()` setup builders.
 */
export interface Process {
  readonly kind: 'process' | undefined
  readonly id: string
  readonly pipelines: readonly Pipeline[]
  readonly mode: ProcessMode
  /** Return a new process with the same id/pipelines; `flag` (default `true`) selects parallel mode, `false` sync. */
  parallel(flag?: boolean): Process
  /** Run every pipeline in this process, sequentially or in parallel depending on `mode`. */
  run(globalContext?: GlobalContext, options?: ProcessRunOptions): Promise<void>
}

export interface ProcessRunOptions extends RunnerOptions {
  /** Called once per pipeline after its Runner has minted a run id, before the run is awaited. */
  onRunner?: (runner: Runner, pipeline: Pipeline) => void
}
