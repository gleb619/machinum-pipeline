import type { ErrorPolicy } from '../contexts.js'
import type { Book } from './domain.js'
import type { Exchange } from './exchange.js'
import type { Logger } from './logging.js'
import type { RunEvents } from './run-events.js'
import type { Settings } from './settings.js'
import type { Vault } from './vault.js'
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
 * Step info — metadata about the current step being executed.
 */
export interface StepInfo {
  stepId: string
  name: string
  type: 'source' | 'tool' | 'target' | 'fork' | 'batch' | 'flatmap' | 'split' | 'tap' | 'subflow'
  index: number
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
 * Target context — target execution context scoped to a run.
 */
export interface TargetContext {
  run: RunContext
  /** In-process run lifecycle event subscription (Runner-built facade). Optional. */
  events?: RunEvents
  /**
   * The persisted source cursor this pipeline level resumes from; undefined on a fresh run.
   * Incremental targets use it to align their run-scoped staging file before appending, so
   * envelopes written past the last durable checkpoint are discarded rather than duplicated.
   */
  resumeCursor?: number
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
 * Tool context — tool execution context scoped to a specific run and step.
 */
export interface ToolContext {
  run: RunContext
  step: StepInfo
}

/**
 * Per-group scope of `.batch(opts, nested)` (see `createBatchScope`). One group, two views,
 * one commit point.
 */
export interface BatchScope {
  /** Id of the folded group exchange. */
  readonly groupId: string
  /** How many results were committed so far (`batch://return` writes). */
  readonly commits: number
  /** The package as ONE exchange (`item` = `items[]`, members carried). */
  group(): Exchange<unknown>
  /** Every member as its own exchange (own id/meta/variables, group edits stamped on). */
  members(): Exchange<unknown>[]
  /** Hand a result back: the group exchange (variable edits) or one member (replaces it by id). */
  commit(env: Exchange<unknown>): void
  /** The original members, patched, as the outer stream continues with them. */
  result(): Exchange<unknown>[]
}

/**
 * Splitter context — splitter execution context scoped to a run.
 */
export interface SplitterContext {
  run: RunContext
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
  /**
   * Set only for the nested run of `.batch(opts, nested)`: the group being processed. The
   * `batch://members`, `batch://group` and `batch://return` waypoints work against it.
   */
  batchScope?: BatchScope
}

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
