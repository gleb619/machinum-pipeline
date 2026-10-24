import type { RetryPolicy, SourceContext, TargetContext, ToolContext } from './contexts.js'

/**
 * Lifecycle type for sources.
 * 'long-lived' sources persist across pauses/resumes.
 * 'resumable' sources can resume from a cursor.
 */
export type Lifecycle = 'long-lived' | 'resumable'

/**
 * Item envelope — the unit of data flowing through a pipeline.
 * Either a single item or a batch of items.
 */
export interface Envelope<T = unknown> {
  item: T
  items?: T[]
  meta: {
    chapterId?: string
    paragraphId?: string
    lineId?: string
    [k: string]: unknown
  }
}

/**
 * Source abstraction — produces items into a pipeline.
 */
export interface Source<T> {
  uri: string
  lifestyle: Lifecycle
  start(ctx: SourceContext): AsyncIterable<Envelope<T>>
  resume?(ctx: SourceContext, cursor: unknown): AsyncIterable<Envelope<T>>
}

/**
 * Target abstraction — consumes items from a pipeline.
 */
export interface Target<T> {
  uri: string
  open(ctx: TargetContext): Promise<void>
  write(env: Envelope<T>, ctx: TargetContext): Promise<void>
  close(ctx: TargetContext): Promise<void>
}

/**
 * Tool abstraction — transforms items in a pipeline.
 *
 * Error contract (read by the engine's retry layer, `engine/retry.ts`): an error thrown from
 * `invoke` with `retryable === false` is fatal — the engine rethrows it immediately, without
 * backoff. Any other error (including `retryable === true`) follows the policy, and a
 * `retryAfterMs` on it overrides the computed backoff, clamped to `RetryPolicy.maxBackoffMs`.
 */
export interface Tool<I, O> {
  name: string
  version: string
  mdDescription: string
  invoke(env: Envelope<I>, ctx: ToolContext): Promise<Envelope<O>>
  cacheable?: boolean
  idempotent?: boolean
}

/**
 * Logger interface — used by the engine to emit log events.
 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  debug(message: string, meta?: Record<string, unknown>): void
}

/**
 * Pipeline definition — the result of definePipeline().
 */
export interface Pipeline<_I = unknown, _O = unknown> {
  id: string
  retry: RetryPolicy
  onError: 'fail-run' | 'skip-item' | 'dead-letter'
  steps: PipelineStep[]
}

/**
 * A single step in a pipeline.
 */
export interface PipelineStep {
  type: 'source' | 'tool' | 'target' | 'fork' | 'batch' | 'window' | 'flatmap' | 'tap' | 'subflow'
  config: Record<string, unknown>
}

/**
 * Run state enumeration.
 */
export type RunState =
  | 'pending'
  | 'running'
  | 'checkpoint'
  | 'paused'
  | 'done'
  | 'failed'
  | 'resumed'

/**
 * Checkpoint tree node.
 */
export interface CheckpointNode {
  stepId: string
  state: 'pending' | 'in-progress' | 'done' | 'failed'
  children?: CheckpointNode[]
  outputHash?: string
  cursor?: unknown
  error?: string
}

/**
 * Event kinds appended to `.mt/runs/<runId>/events.jsonl` (the SSE source, UC015/UC029).
 */
export type RunEventType = 'started' | 'step-done' | 'paused' | 'resumed' | 'done' | 'failed'

/**
 * One line of the append-only run event log.
 *
 * Written by the Runner, tailed by the backend and replayed over SSE. `stepId` is set on
 * `step-done` events only; `error` on `failed` ones.
 */
export interface RunEvent {
  type: RunEventType
  ts: string
  runId: string
  stepId?: string
  error?: string
}

/**
 * Run metadata — persisted to state.json.
 */
export interface RunStateData {
  runId: string
  pipelineId: string
  state: RunState
  startedAt: string
  updatedAt: string
  checkpoint: CheckpointNode
  contextRef: string
}

/**
 * A write *intent* from a tool to an `md://` directory target.
 *
 * Tools describe what to write, never where: the target resolves `subdir` and
 * `filename` against its own root (URI path, `waypoint.md.defaultFolder`, or
 * `project.root`) and validates both. Tools must not embed the target root here.
 */
export interface MdOutputEntry {
  /** Logical slot name (e.g. 'schema-doc'); used in diagnostics. */
  name: string
  /** Path relative to the target root. `''` (default) = the root itself. No absolute paths, no `..`. */
  subdir?: string
  /** @deprecated Use `subdir`. Treated as `subdir` by the `md://` target; removed next release. */
  dir?: string
  /** Basename only — no path separators. */
  filename: string
  content: string
}
