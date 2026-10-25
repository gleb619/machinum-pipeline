import type { Book } from './domain.js'
import type { Settings } from './settings.js'
import type { Logger, RunEvents } from './types.js'
import type { Vault } from './vault.js'

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
  settings: Settings
  routerUrl?: string
  env: Record<string, string>
  /**
   * Sensitive endpoint store. Attached as a NON-enumerable property so it never leaks
   * into JSON.stringify / spreads / checkpoints / logs. Access via `ctx.vault` only.
   */
  vault?: Vault
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
  /** Absolute path to .mt/runs/<runId>/artifacts/ — for persisting intermediate outputs */
  artifactsDir: string
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
  /** In-process run lifecycle event subscription (Runner-built facade). Optional. */
  events?: RunEvents
}

/**
 * Target context — target execution context scoped to a run.
 */
export interface TargetContext {
  run: RunContext
  /** In-process run lifecycle event subscription (Runner-built facade). Optional. */
  events?: RunEvents
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
  type: 'source' | 'tool' | 'target' | 'fork' | 'batch' | 'window' | 'flatmap' | 'tap' | 'subflow'
  index: number
}

/**
 * Retry policy configuration.
 */
export interface RetryPolicy {
  max: number
  backoffMs: number
  strategy: 'fixed' | 'linear' | 'exp'
  /**
   * Ceiling for any single wait, in ms. Applies to the computed backoff and to a
   * server-supplied `retryAfterMs`. Unset means `DEFAULT_MAX_BACKOFF_MS` (60s).
   */
  maxBackoffMs?: number
}

/**
 * Error policy — what to do when a step fails.
 */
export type ErrorPolicy = 'fail-run' | 'skip-item' | 'dead-letter'

/**
 * Retry strategy types.
 */
export type RetryStrategy = 'fixed' | 'linear' | 'exp'
