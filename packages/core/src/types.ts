import type {
  RetryPolicy,
  SourceContext,
  SplitterContext,
  TargetContext,
  ToolContext,
} from './contexts.js'
import type { Exchange, ExchangeInput } from './exchange.js'

/**
 * Lifecycle type for sources.
 * 'long-lived' sources persist across pauses/resumes.
 * 'resumable' sources can resume from a cursor.
 */
export type Lifecycle = 'long-lived' | 'resumable'

/**
 * @deprecated Use {@link Exchange}. Kept as an alias so call sites migrate incrementally.
 */
export type Envelope<T = unknown> = Exchange<T>

/**
 * Source abstraction — produces items into a pipeline.
 */
export interface Source<T> {
  uri: string
  lifestyle: Lifecycle
  start(ctx: SourceContext): AsyncIterable<ExchangeInput<T>>
  resume?(ctx: SourceContext, cursor: unknown): AsyncIterable<ExchangeInput<T>>
}

/**
 * Target abstraction — consumes items from a pipeline.
 */
export interface Target<T> {
  uri: string
  open(ctx: TargetContext): Promise<void>
  write(ex: Exchange<T>, ctx: TargetContext): Promise<void>
  close(ctx: TargetContext): Promise<void>
  /**
   * Durably committed envelope count for the current open session (since `open()`),
   * read by the Runner at mid-run persist time (UC015/UC016). The persisted source
   * cursor is clamped to `baseCursor + checkpoint()`, so a resumed run never skips
   * items whose output has not reached durable storage.
   *
   * Targets that buffer and publish atomically on `close()` (e.g. temp+rename file
   * targets) must NOT implement this hook: without it the engine treats nothing as
   * committed mid-run, so the cursor stays at its pre-run position and a crash
   * resume replays safely instead of losing output.
   */
  checkpoint?(ctx: TargetContext): Promise<number | undefined>
}

/**
 * Tool abstraction — transforms an Exchange in a pipeline. `I`/`O` are payload types wrapped in
 * the Exchange; the output must be derived from the input (`withItem`, `pushVariable`, ...) so
 * `id`, `meta` and `variables` propagate.
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
  invoke(ex: Exchange<I>, ctx: ToolContext): Promise<Exchange<O>>
  cacheable?: boolean
  idempotent?: boolean
}

/**
 * Splitter abstraction — fans a buffered Exchange out into child entities.
 *
 * Unlike a tool, a splitter receives the full Exchange (item + meta + variables), so it can
 * derive child ids from in-flight identity metadata without turning that metadata into a
 * payload field. The Runner emits one child envelope per returned entity (1 → N).
 */
export interface Splitter<O = unknown> {
  name: string
  split(env: Exchange<unknown>, ctx?: SplitterContext): O[] | Promise<O[]>
}

/**
 * Write side of a process-local entity buffer.
 *
 * A string-form `.subflow('<splitter>', '<namespace>')` resolves the buffer writer for
 * the splitter's scheme and publishes every child envelope it produces. The writer is a
 * plain lifecycle pair (`reset` before the stage, `append` per envelope) so `core` stays
 * independent of any concrete buffer implementation; `@mt/waypoint` registers the
 * in-memory entity buffers (`chunks://`, `paragraphs://`, ...).
 */
export interface BufferWriter {
  /** Start a fresh buffer: drop everything a previous run left behind. */
  reset(): void
  /** Append one published envelope. */
  append(env: Exchange<unknown>): void
}

/** Factory for a namespace-scoped {@link BufferWriter}. */
export type BufferWriterFactory = (namespace: string) => BufferWriter

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
  /**
   * Pipeline-scoped env defaults (from `defineProcess().config({ env })`), merged into the
   * run env by the Runner for keys not already set in `process.env` or the mt.json env.
   */
  envDefaults?: Record<string, string>
}

/**
 * Config shapes carried by a `fork` step:
 *
 * - sequential `.fork(pipeline)`: `{ pipeline }`
 * - parallel `.fork(name, branches)`: `{ name, pipelines, parallel: true }`
 *
 * `PipelineStep.config` stays a plain record; this type documents the two fork variants.
 */
export type ForkStepConfig =
  | { pipeline: Pipeline }
  | { name: string; pipelines: Pipeline[]; parallel: true }

/**
 * A single step in a pipeline.
 *
 * Fork steps use one of the two {@link ForkStepConfig} shapes.
 */
export interface PipelineStep {
  type: 'source' | 'tool' | 'target' | 'fork' | 'batch' | 'flatmap' | 'split' | 'tap' | 'subflow'
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
 * Listener for run lifecycle events (in-process counterpart of the events.jsonl log).
 * May return a promise — the Runner never awaits it; rejections are logged, never thrown.
 */
export type RunEventListener = (event: RunEvent) => void | Promise<void>

/**
 * Read-only subscription surface for run lifecycle events, exposed to source/target
 * contexts. Implemented by the Runner; waypoints never see the Runner itself.
 */
export interface RunEvents {
  /** Subscribe to run lifecycle events. Returns an unsubscribe function. */
  subscribe(listener: RunEventListener): () => void
}

/**
 * Run metadata — persisted to state.json.
 */
export interface RunStateData {
  runId: string
  pipelineId: string
  /** Pipeline source file relative to the project root, recorded so `mt resume <runId>` can find it. */
  pipelineFile?: string
  /** Named export of the pipeline in `pipelineFile`, when the run was started with `--pipeline`. */
  pipelineName?: string
  state: RunState
  startedAt: string
  updatedAt: string
  checkpoint: CheckpointNode
  contextRef: string
}

/**
 * Runner constructor options — provenance recorded into state.json so a run can be
 * resumed (`mt resume <runId>`) without the operator remembering the pipeline file.
 */
export interface RunnerOptions {
  pipelineFile?: string
  pipelineName?: string
  /** Initial run event listeners, seeded before `start()` (same as `subscribeEvents`). */
  events?: RunEventListener[]
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
