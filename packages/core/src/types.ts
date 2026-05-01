import type { SourceContext, TargetContext, ToolContext } from './contexts.js'

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
 */
export interface Tool<I, O> {
  name: string
  version: string
  invoke(env: Envelope<I>, ctx: ToolContext): Promise<Envelope<O>>
  exec?: 'inproc' | 'npx' | 'deno' | 'bun'
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
  retry: { max: number; backoffMs: number; strategy: 'fixed' | 'linear' | 'exp' }
  onError: 'fail-run' | 'skip-item' | 'dead-letter'
  steps: PipelineStep[]
}

/**
 * A single step in a pipeline.
 */
export interface PipelineStep {
  type: 'source' | 'tool' | 'target' | 'fork' | 'batch' | 'window' | 'flatmap' | 'tap'
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
