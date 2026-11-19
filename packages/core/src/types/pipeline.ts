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
   * Implement it only when every resolved `write()` is flushed (and fsynced where the
   * sink supports it) before the promise settles. Append-style targets that stage into
   * a run-scoped temp file must also honour {@link TargetContext.resumeCursor} in
   * `open()`: truncate the staging file to that boundary before appending, so a resume
   * replays exactly the envelopes the persisted cursor has not yet accounted for.
   *
   * Targets that only publish on `close()` and cannot align their staging must omit this
   * hook — the engine then leaves the cursor at its pre-run position.
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
  description: string
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
 * Publishing into a buffer is an explicit target now: a split-form subflow child writes
 * into `<scheme>://<namespace>` with its own `.to(...)`, and the registered Target for
 * the scheme shares this writer's lifecycle (`reset` when the target opens — once per
 * stage — and `append` per envelope). The writer itself is a plain lifecycle pair so
 * `core` stays independent of any concrete buffer implementation; `@mt/waypoint`
 * registers the in-memory entity buffers (`chunks://`, `paragraphs://`, ...).
 */
export interface BufferWriter {
  /** Start a fresh buffer: drop everything a previous run left behind. */
  reset(): void
  /** Append one published envelope. */
  append(env: Exchange<unknown>): void
}

/**
 * A single step in a pipeline.
 *
 * Fork steps use one of the two {@link ForkStepConfig} shapes. A `batch` step is engine-internal:
 * the DSL creates it only through the batch subflow form
 * `.subflow('batch://[tumbling|slide][?size=N][&slide=true|false]', pipe)` — its config is
 * `{ size, slide, pipeline }`, the child running once per package (`batch://group|members|return`
 * are the child-side views).
 */
export interface PipelineStep {
  type: 'source' | 'tool' | 'target' | 'fork' | 'batch' | 'flatmap' | 'split' | 'tap' | 'subflow'
  config: Record<string, unknown>
}

/**
 * `before` pipeline interceptor — runs before a tool step invocation.
 * May return a (possibly modified) exchange to feed the tool instead of the incoming one,
 * or void to keep the current exchange. Throwing skips the tool invoke; the error follows
 * the step's normal retry/error policy.
 */
// `void` means "return nothing, keep the exchange" (mirrors `.tap()`'s callback contract).
export type BeforeInterceptor = (
  ex: Exchange<unknown>,
  ctx: ToolContext,
  // biome-ignore lint/suspicious/noConfusingVoidType: explicit "return nothing" contract
) => Exchange<unknown> | void | Promise<Exchange<unknown> | undefined>

/**
 * `after` pipeline interceptor — runs after a successful tool invocation only (never on
 * error, including after retries are exhausted). May return a (possibly modified) exchange
 * to pass downstream, or void to keep the tool's output.
 */
export type AfterInterceptor = (
  ex: Exchange<unknown>,
  ctx: ToolContext,
  // biome-ignore lint/suspicious/noConfusingVoidType: explicit "return nothing" contract
) => Exchange<unknown> | void | Promise<Exchange<unknown> | undefined>

/**
 * Per-`.use()` params function — transforms the incoming exchange (e.g. `withMeta`) just
 * before the tool's `invoke`. Runs inside the step's retry/error policy, with the same
 * `ToolContext` the tool receives; a `void` (or omitted) return keeps the incoming exchange.
 */
export type ToolParams<I = unknown> = (
  env: Exchange<I>,
  ctx: ToolContext,
  // biome-ignore lint/suspicious/noConfusingVoidType: a `void` (or omitted) return keeps the incoming exchange
) => Exchange<I> | void | Promise<Exchange<I> | void>

/** Continuation passed to an {@link AroundInterceptor}; invokes the rest of the chain. */
export type AroundNext = (ex: Exchange<unknown>) => Promise<Exchange<unknown>>

/**
 * `around` pipeline interceptor — middleware-style wrapper around a tool invocation.
 * `next` invokes the remaining around interceptors (in registration order, onion-nested)
 * and finally the tool itself; the result must be the (possibly replaced) output exchange.
 * Async, time measurement, error catching and exchange swapping are all supported.
 */
export type AroundInterceptor = (
  ex: Exchange<unknown>,
  ctx: ToolContext,
  next: AroundNext,
) => Promise<Exchange<unknown>>

/**
 * One registered pipeline interceptor. Registrations stack on the builder and run in
 * registration order (`before`/`after`); `around` interceptors nest like onion middleware
 * with the first-registered outermost.
 */
export type PipelineInterceptor =
  | { kind: 'before'; fn: BeforeInterceptor }
  | { kind: 'after'; fn: AfterInterceptor }
  | { kind: 'around'; fn: AroundInterceptor }

/**
 * Pipeline definition — the result of definePipeline().
 */
export interface Pipeline<_I = unknown, _O = unknown> {
  id: string
  retry: RetryPolicy
  onError: 'fail-run' | 'skip-item' | 'dead-letter'
  steps: PipelineStep[]
  /**
   * Tool-invocation interceptors registered via `.before()`/`.after()`/`.around()`.
   * The Runner wraps every `.use()` tool invoke with them. Fork/subflow child pipelines
   * without their own interceptors inherit the parent's (nested pipelines included).
   * Absent (`undefined`) means "not overridden" — children inherit, the top level uses none.
   */
  interceptors?: readonly PipelineInterceptor[]
  /**
   * Pipeline-scoped env defaults (from `defineProcess().config({ env })`), merged into the
   * run env by the Runner for keys not already set in `process.env` or the mt.json env.
   */
  envDefaults?: Record<string, string>
}
