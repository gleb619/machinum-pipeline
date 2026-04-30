import type { Book } from './domain.js'
import type { Logger } from './types.js'

/**
 * Global context — one per project, derived from mt.json at CLI start.
 */
export interface GlobalContext {
  project: {
    name: string
    root: string
  }
  book?: Book
  defaults: {
    retry: RetryPolicy
    onError: ErrorPolicy
    concurrency: number
  }
  routerUrl?: string
  env: Record<string, string>
}

/**
 * Run context — one per run, carries identity, config snapshot, logger, and checkpoint handle.
 */
export interface RunContext {
  runId: string
  pipelineId: string
  startedAt: string
  global: GlobalContext
  checkpoint: CheckpointHandle
  logger: Logger
}

/**
 * Tool context — tool execution context scoped to a specific run and step.
 */
export interface ToolContext {
  run: RunContext
  step: StepInfo
}

/**
 * Source context — source execution context scoped to a run.
 */
export interface SourceContext {
  run: RunContext
}

/**
 * Target context — target execution context scoped to a run.
 */
export interface TargetContext {
  run: RunContext
}

/**
 * Checkpoint handle — opaque reference to the current position in the checkpoint tree.
 */
export interface CheckpointHandle {
  stepId: string
  depth: number
  path: string[]
}

/**
 * Step info — metadata about the current step being executed.
 */
export interface StepInfo {
  stepId: string
  name: string
  type: 'source' | 'tool' | 'target' | 'fork'
  index: number
}

/**
 * Retry policy configuration.
 */
export interface RetryPolicy {
  max: number
  backoffMs: number
  strategy: 'fixed' | 'linear' | 'exp'
}

/**
 * Error policy — what to do when a step fails.
 */
export type ErrorPolicy = 'fail-run' | 'skip-item' | 'dead-letter'

/**
 * Retry strategy types.
 */
export type RetryStrategy = 'fixed' | 'linear' | 'exp'
