import { basename, dirname } from 'node:path'
import { type Annotation, annotate } from './annotation.js'
import { loadGlobalContext } from './config.js'
import { Runner } from './engine/runner.js'
import { toExchange } from './exchange.js'
import { type LogSeverity, createConsoleLogger, log } from './logging.js'
import type { ProcessMode } from './process.js'
import type {
  AfterInterceptor,
  AroundInterceptor,
  BatchOptions,
  BeforeInterceptor,
  ComposableTool,
  Exchange,
  ExchangeInput,
  GlobalContext,
  LogOptions,
  Pipeline,
  PipelineInterceptor,
  PipelineStep,
  Process,
  ProcessConfig,
  ProcessOptions,
  ProcessRunOptions,
  RetryPolicy,
  Source,
  SourceContext,
  Target,
  TargetContext,
  Tool,
  ToolArg,
  ToolContext,
  ToolParams,
  WaypointSourceHooks,
  WaypointTargetHooks,
} from './types.js'
import { registry } from './uri.js'

/**
 * Default retry configuration
 */
const DEFAULT_RETRY = { max: 3, backoffMs: 1000, strategy: 'exp' as const }
const DEFAULT_ON_ERROR: 'fail-run' | 'skip-item' | 'dead-letter' = 'fail-run'

/** Default `batch://` package size (`.subflow('batch://', pipe)`). */
export const DEFAULT_BATCH_SIZE = 5

/** Batch modes accepted as the `batch://` authority segment. */
const BATCH_MODES = new Set(['', 'tumbling', 'slide'])

/** Query keys accepted by `batch://...` (`batchSize` is the documented alias of `size`). */
const BATCH_QUERY_KEYS = new Set(['size', 'batchSize', 'slide'])

/** Child-side `batch://` views — never a subflow source, only a child-internal one. */
const BATCH_CHILD_VIEWS = new Set(['group', 'members', 'return'])

/** Definition-time label of the batch form, used in every error message. */
function batchOp(uri: string): string {
  return `.subflow('${uri}', pipeline)`
}

/**
 * Parse the batch subflow URI `batch://[tumbling|slide][?size=N][&slide=true|false]`
 * into its package options. `batchSize` is accepted as an alias of `size`; an explicit
 * `?slide=` wins over the mode segment.
 *
 * Everything is validated here, at pipeline-definition time: an unknown mode segment, an
 * unknown query key, a non-positive/non-integer size or a non-boolean slide throws
 * (`TypeError` for grammar, `RangeError` for the size) with a message naming the URI form.
 */
export function parseBatchUri(uri: string): Required<BatchOptions> {
  const op = batchOp(uri)
  const parsed = registry.parse(uri)
  const mode = `${parsed.host}${parsed.path}`
  if (!BATCH_MODES.has(mode)) {
    throw new TypeError(
      `${op}: unknown batch mode '${mode}' — use 'batch://', 'batch://tumbling' or 'batch://slide'`,
    )
  }
  for (const key of Object.keys(parsed.query)) {
    if (!BATCH_QUERY_KEYS.has(key)) {
      throw new TypeError(
        `${op}: unknown query parameter '${key}' — allowed: size, batchSize, slide`,
      )
    }
  }
  const rawSize = parsed.query.size ?? parsed.query.batchSize
  const size = rawSize === undefined ? DEFAULT_BATCH_SIZE : Number(rawSize)
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`${op}: size must be a positive integer, got ${rawSize ?? String(size)}`)
  }
  let slide = mode === 'slide'
  const rawSlide = parsed.query.slide
  if (rawSlide !== undefined) {
    if (rawSlide !== 'true' && rawSlide !== 'false') {
      throw new TypeError(`${op}: slide must be 'true' or 'false', got '${rawSlide}'`)
    }
    slide = rawSlide === 'true'
  }
  return { size, slide }
}

/**
 * Definition-time guard for a batch child pipeline: it must be a real pipeline and must not
 * declare a source of its own — it receives the package envelope from the parent stream.
 * The only exception is the advanced child-side `batch://` views (`batch://group`,
 * `batch://members`, multi-stage `.from('batch://members')` chains), which read the package
 * or its members from the scope.
 */
function assertBatchPipeline(op: string, pipeline: unknown): asserts pipeline is Pipeline {
  if (!isPipeline(pipeline)) {
    throw new TypeError(`${op}: pipeline must be an object with a string id and a steps array`)
  }
  for (const step of pipeline.steps) {
    if (step.type !== 'source') continue
    const uri = String((step.config as { uri?: unknown }).uri ?? '')
    let scheme = ''
    try {
      scheme = registry.parse(uri).scheme
    } catch {
      scheme = ''
    }
    if (scheme !== 'batch') {
      throw new TypeError(
        `${op}: pipeline '${pipeline.id}' must not declare its own source ('${uri}') — it receives the package from the parent stream; only batch:// views are allowed inside it`,
      )
    }
  }
}

/**
 * A batch child without its own target gets a `batch://return` target injected: the package
 * has to be handed back to the scope so its members continue patched. The URI resolves at run
 * time (the waypoints are registered by `@mt/waypoint`), so defining a pipeline never
 * requires the `batch://` views to be registered.
 */
function withBatchReturn(pipeline: Pipeline): Pipeline {
  if (pipeline.steps.some((step) => step.type === 'target')) return pipeline
  return withSteps(pipeline, [
    ...pipeline.steps,
    { type: 'target', config: { uri: 'batch://return' } },
  ])
}

/**
 * Definition-time guard shared by `.fork()`/`.forkSync()` branches and split-form
 * `.subflow('<source>', pipeline)` children: the child must be a real pipeline and must
 * not declare its own source — it receives envelopes from the parent stream.
 */
function assertNestedPipeline(
  op: string,
  role: string,
  pipeline: unknown,
): asserts pipeline is Pipeline {
  if (!isPipeline(pipeline)) {
    throw new TypeError(`${op}: ${role} must be an object with a string id and a steps array`)
  }
  if (pipeline.steps.some((step) => step.type === 'source')) {
    throw new TypeError(
      `${op}: ${role} pipeline '${pipeline.id}' must not declare its own source (.from()) — it receives envelopes from the parent stream`,
    )
  }
}

/**
 * Validate `.fork()`/`.forkSync()` branches: at least one pipeline, each passing the
 * shared nested-pipeline guard (no own source).
 */
function assertForkBranches(op: string, pipelines: readonly Pipeline[]): void {
  if (pipelines.length === 0) {
    throw new TypeError(`${op}: at least one branch pipeline is required`)
  }
  for (const [index, branch] of pipelines.entries()) {
    assertNestedPipeline(op, `branches[${index}]`, branch)
  }
}

/**
 * Copy of `pipeline` with its steps replaced. A `PipelineBuilder` exposes `id`, `retry`,
 * `onError`, `steps` and `interceptors` as prototype getters, so spreading it would silently
 * drop them — the fields are copied explicitly.
 */
function withSteps(pipeline: Pipeline, steps: PipelineStep[]): Pipeline {
  return {
    id: pipeline.id,
    retry: pipeline.retry,
    onError: pipeline.onError,
    steps,
    interceptors: pipeline.interceptors,
    envDefaults: pipeline.envDefaults,
  }
}

/**
 * A split-form subflow child without its own target gets a `void://` target injected:
 * the branch must be drained for its side effects, and `void://` discards every envelope.
 * The URI resolves at run time (like an alias), so defining a pipeline never requires the
 * `void://` waypoint to be registered.
 */
function withVoidTarget(pipeline: Pipeline): Pipeline {
  if (pipeline.steps.some((step) => step.type === 'target')) return pipeline
  return withSteps(pipeline, [...pipeline.steps, { type: 'target', config: { uri: 'void://' } }])
}

let warnedAboutPipelineId = false

/** One-shot warning: pipeline ids cannot be inferred from the stack under bun. */
function warnUnresolvablePipelineId(): void {
  if (warnedAboutPipelineId) return
  warnedAboutPipelineId = true
  createConsoleLogger().warn(
    '[mt] Cannot infer pipeline id from the call stack on this runtime — pass an explicit ' +
      "`id` to definePipeline({ id: '...' }).",
  )
}

/**
 * Pipeline id derived from a pipeline file path: the file name without extension, or the
 * parent directory name for `index.ts` / `pipeline.ts`.
 */
export function derivePipelineId(filePath: string): string {
  if (!filePath.endsWith('.ts')) return 'default-pipeline'
  const base = basename(filePath, '.ts')
  if (base === 'index' || base === 'pipeline') return basename(dirname(filePath))
  return base
}

/**
 * Extract pipeline ID from caller filename using stack trace analysis.
 * Falls back to 'default-pipeline' if unable to determine.
 */
function getCallerFileId(): string {
  const originalPrepareStackTrace = Error.prepareStackTrace
  try {
    Error.prepareStackTrace = (_, stack) => stack
    const err = new Error()
    const stack = err.stack as unknown as NodeJS.CallSite[]

    // Bun (and any other engine without V8 call sites) returns a plain string
    // here — the id cannot be derived, so the caller must pass an explicit `id`.
    if (!Array.isArray(stack)) {
      warnUnresolvablePipelineId()
      return 'default-pipeline'
    }

    // Find the caller (skip this function, getCallerFileId, and the definePipeline call)
    for (let i = 2; i < stack.length; i++) {
      const caller = stack[i]
      if (!caller) continue
      if (typeof caller.getFileName !== 'function') continue
      const fileName = caller.getFileName()
      if (fileName?.endsWith('.ts') && !fileName.includes('node_modules')) {
        return derivePipelineId(fileName)
      }
    }
  } catch {
    // Fallback
  } finally {
    Error.prepareStackTrace = originalPrepareStackTrace
  }
  return 'default-pipeline'
}

/**
 * DSL builder for defining a pipeline.
 * Chain: .from(source).use(tool).to(target)
 * Also supports .fork(), .subflow() (inline, split and batch forms), .flatMap(), .tap(), .log()
 * for branching, orchestration, and transformation logic.
 *
 * PipelineBuilder implements Pipeline directly — it can be used as a
 * default export without calling .to() (subflow-only orchestration mode).
 *
 * @param config - Optional configuration. If omitted, uses defaults:
 *   - id: derived from filename (e.g., 'my-pipeline' from 'my-pipeline.ts')
 *   - retry: { max: 3, backoffMs: 1000, strategy: 'exp' }
 *   - onError: 'fail-run'
 *
 * @example
 * // Full pipeline with source/target
 * definePipeline({ id: 'my-pipeline' })
 *   .from('jsonl://./input.jsonl')
 *   .use(myTool)
 *   .to('md://./output.md')
 *
 * @example
 * // Subflow-only orchestration (no .to() needed — builder IS a Pipeline)
 * export default definePipeline()
 *   .subflow(verifyFlow)
 *   .subflow(translateFlow)
 */
export function definePipeline<I = unknown, O = unknown>(config?: {
  id?: string
  retry?: RetryPolicy
  onError?: 'fail-run' | 'skip-item' | 'dead-letter'
}): PipelineBuilder<I, O> {
  const id = config?.id ?? getCallerFileId()
  const retry = config?.retry ?? DEFAULT_RETRY
  const onError = config?.onError ?? DEFAULT_ON_ERROR
  return new PipelineBuilder<I, O>({ id, retry, onError })
}

/**
 * Builder class for constructing a pipeline definition via a fluent API.
 *
 * Implements Pipeline directly so it can be exported as a module default
 * without requiring a terminal .to() call. When .to() is called,
 * it returns the same builder cast to Pipeline (the terminal step).
 */
export class PipelineBuilder<I, O> implements Pipeline<I, O> {
  private readonly _id: string
  private readonly _retry: RetryPolicy
  private readonly _onError: 'fail-run' | 'skip-item' | 'dead-letter'
  private readonly _steps: PipelineStep[] = []
  private readonly _interceptors: PipelineInterceptor[] = []
  /** Set by `defineProcess().config({ env }).pipeline(...)` — pipeline-scoped env defaults. */
  envDefaults?: Record<string, string>

  get id(): string {
    return this._id
  }
  get retry(): RetryPolicy {
    return this._retry
  }
  get onError(): 'fail-run' | 'skip-item' | 'dead-letter' {
    return this._onError
  }
  get steps(): PipelineStep[] {
    return this._steps
  }
  /**
   * Registered tool-invocation interceptors, or `undefined` when none were registered —
   * the Runner then inherits the parent pipeline's interceptors (nested pipelines included).
   */
  get interceptors(): readonly PipelineInterceptor[] | undefined {
    return this._interceptors.length > 0 ? this._interceptors : undefined
  }

  constructor(config: {
    id: string
    retry: RetryPolicy
    onError: 'fail-run' | 'skip-item' | 'dead-letter'
  }) {
    this._id = config.id
    this._retry = config.retry
    this._onError = config.onError
  }

  /**
   * Set the source for the pipeline.
   * @param source - Source instance OR URI string (sugar)
   *
   * @example
   * // Using Source instance
   * .from(source('jsonl://./input.jsonl'))
   *
   * @example
   * // Using URI string (sugar)
   * .from('jsonl://./input.jsonl')
   */
  from<T>(source: Source<T> | string): PipelineBuilder<T, O> {
    this._steps.push({
      type: 'source',
      config: this.resolveEndpoint(source, (uri) => registry.resolveSource<T>(uri)),
    })
    return this as unknown as PipelineBuilder<T, O>
  }

  /** Sugar: `.use()` each tool in order (same as chaining `.use()` calls). */
  useAll(...tools: Tool<never, unknown>[]): PipelineBuilder<unknown, O> {
    for (const tool of tools) this.use(tool as Tool<unknown, unknown>)
    return this as unknown as PipelineBuilder<unknown, O>
  }

  /**
   * Append a tool step. The optional second argument is either a params function or a
   * per-step overrides object.
   *
   * A params function transforms the incoming exchange (e.g. attaching meta via
   * `withMeta`) just before the tool's `invoke` — applied first, then the pipeline's
   * interceptors. It runs inside the step's retry/error policy with the same
   * `ToolContext` the tool receives; returning void keeps the incoming exchange.
   *
   * @example
   * .use(replaceDots, (env) => withMeta(env, { chapter: routeKey(meta.number, 'commas') }))
   * .use(myTool, { retry: { backoffMs: 50 }, onError: 'skip-item' })
   */
  use<T, R>(
    tool: Tool<T, R>,
    paramsOrOverrides?:
      | ToolParams<T>
      | {
          retry?: Partial<RetryPolicy>
          onError?: 'fail-run' | 'skip-item' | 'dead-letter'
        },
  ): PipelineBuilder<R, O> {
    const params = typeof paramsOrOverrides === 'function' ? paramsOrOverrides : undefined
    const overrides = typeof paramsOrOverrides === 'object' ? paramsOrOverrides : undefined
    this._steps.push({
      type: 'tool',
      config: {
        name: tool.name,
        version: tool.version,
        tool,
        params,
        retry: overrides?.retry,
        onError: overrides?.onError,
      },
    })
    return this as unknown as PipelineBuilder<R, O>
  }

  /**
   * Set the target for the pipeline.
   * Ends the stage — the builder doubles as the completed Pipeline. A further `.from()` starts
   * the next stage (used by batch children: the group stage, then the members stage).
   *
   * @param target - Target instance OR URI string (sugar)
   *
   * @example
   * // Using Target instance
   * .to(target('md://./output.md'))
   *
   * @example
   * // Using URI string (sugar)
   * .to('md://./output.md')
   */
  to<T>(target: Target<T> | string): PipelineBuilder<I, O> {
    this._steps.push({
      type: 'target',
      config: this.resolveEndpoint(target, (uri) => registry.resolveTarget<T>(uri)),
    })
    return this
  }

  flatMap<R>(fn: (item: I) => Promise<R[]>): PipelineBuilder<R, O> {
    this._steps.push({ type: 'flatmap', config: { fn } })
    return this as unknown as PipelineBuilder<R, O>
  }

  /**
   * Fork the stream into several branches that run CONCURRENTLY per envelope.
   *
   * Every branch runs in parallel for each parent envelope (an isolated deep-cloned
   * envelope per branch); their buffered output is merged in branch declaration order.
   * Branches are validated at definition time: each argument must be a pipeline and must
   * not declare its own source (`branch` receiving envelopes from the parent stream is the
   * contract; `.from()` inside a branch is a TypeError). A branch without a target merges
   * its output back into the parent stream; an explicit `.to()` redirects it. Accepts
   * 1..N pipelines. For the sequential variant use {@link forkSync}.
   *
   * @example
   * .fork(countBranch, reorderBranch, commasBranch)
   */
  fork(...pipelines: readonly Pipeline[]): PipelineBuilder<I, O> {
    assertForkBranches('.fork(...pipelines)', pipelines)
    this._steps.push({ type: 'fork', config: { pipelines: [...pipelines], parallel: true } })
    return this
  }

  /**
   * Sequential fork — run each branch pipeline per envelope, one branch after another.
   *
   * Pushes one sequential fork step per pipeline (chained): every parent envelope runs
   * branch 1 to completion, then branch 2, ... and each branch's output is merged back
   * into the parent stream in arrival order. Same definition-time validation as
   * {@link fork}: every argument must be a pipeline without its own source.
   *
   * @example
   * .forkSync(countBranch, reorderBranch)
   */
  forkSync(...pipelines: readonly Pipeline[]): PipelineBuilder<I, O> {
    assertForkBranches('.forkSync(...pipelines)', pipelines)
    for (const pipeline of pipelines) {
      this._steps.push({ type: 'fork', config: { pipeline } })
    }
    return this
  }

  /**
   * Run an inline sub-pipeline, fan the stream out through a splitter, or run the stream through
   * a batch child — one call per package.
   *
   * Pipeline form (`.subflow(pipeline)`): inline nested pipeline in the same Runner (a
   * steps-only child is spliced into the parent stream; a child with its own source is
   * self-contained and leaves the parent stream untouched).
   *
   * Split form (`.subflow('<source>', pipeline)`): resolve the registered `Splitter` for
   * the source URI's scheme and fan the stream out 1 → N per envelope. For example
   * `.subflow('paragraphs://', pipe)` splits chunks into paragraphs and runs each one
   * through `pipe`. `'paragraphs://'` and `'#paragraphs'` are equivalent; a bare
   * `'paragraphs'` is rejected. The splitter receives the full Exchange. The child
   * pipeline runs synchronously and sequentially as a side branch — the PARENT stream
   * passes through unchanged, and the children of one envelope are fully processed
   * before the next parent envelope continues. A child with a target writes there
   * (e.g. `.to('chunks://ladder')` fills an entity buffer); a child without one gets
   * `void://` injected so the branch's side effects still run. Definition-time
   * validation: unknown splitter schemes throw, the second argument must be a pipeline,
   * and a child that declares its own source (`.from()`) is a TypeError.
   *
   * Batch form (`.subflow('batch://[tumbling|slide][?size=N][&slide=true|false]', pipeline)`):
   * group the parent stream into packages of `size` (default {@link DEFAULT_BATCH_SIZE}),
   * flushing the remainder at end of stream, and run the child ONCE per package — the fan-in
   * twin of the split form:
   *
   * - the package is ONE exchange (`id = batch-<...>`, `item` = the member payloads, `items`
   *   set, members carried in the ephemeral `batchMembers` variable) and it is handed to the
   *   child as its input stream, so a child that starts with `.use(...)` needs no `.from()`;
   * - a child without a target gets `batch://return` injected — it hands the patched package
   *   back to the scope;
   * - the parent stream continues with the ORIGINAL member envelopes (own id, meta, variables,
   *   order). Group output: its CHANGED variables are stamped on every member and, when the
   *   package payload is an array of the same length as the package, member `i` receives
   *   `items[i]` (an explicit member commit by id wins over that zip); member output replaces
   *   that member;
   * - a child with its own `.to(<uri>)` writes there and nothing flows back — a sink, same as a
   *   split child. The parent members still continue downstream (drained when the parent has no
   *   target);
   * - `slide` (`.subflow('batch://slide?size=3', pipe)`) moves one item per arrival, so
   *   consecutive packages overlap;
   * - the child may use the advanced views explicitly — `batch://group` (the package as one
   *   exchange), `batch://members` (every member as its own exchange, multi-stage chains
   *   included) and `batch://return`; those are child-side only, so they are rejected in the
   *   subflow source position;
   * - the checkpoint node of one package is `<stepId>/batch-<n>`. Package grouping and scope
   *   state are in memory only: after a crash the package is re-formed from the source cursor
   *   and the child replays for it.
   *
   * `.fork()` is per-envelope branch nesting (parallel or via {@link forkSync}
   * sequential), not a split: it is too heavy for a plain 1 → N transformation.
   *
   * @example
   * .subflow('batch://?size=5', definePipeline({ id: 'translate-titles' })
   *   .use(extractTitles)     // env.item = unknown[], env.items = the same array
   *   .use(translateTitles)   // one call for the whole package
   *   .use(applyTitles))      // returns the patched package
   */
  subflow(pipeline: Pipeline<I, unknown>): PipelineBuilder<I, O>
  subflow(source: `batch://${string}`, pipeline: Pipeline<unknown, unknown>): PipelineBuilder<I, O>
  subflow(source: string, pipeline: Pipeline<unknown, unknown>): PipelineBuilder<unknown, O>
  subflow(
    arg: Pipeline<I, unknown> | string,
    maybePipeline?: Pipeline<unknown, unknown>,
  ): PipelineBuilder<unknown, O> {
    if (typeof arg === 'string') {
      if (registry.splitterScheme(arg) === 'batch') {
        return this.batchSubflow(arg, maybePipeline) as unknown as PipelineBuilder<unknown, O>
      }
      const op = `.subflow('${arg}', pipeline)`
      assertNestedPipeline(op, 'pipeline', maybePipeline)
      const splitter = registry.resolveSplitter<unknown>(arg)
      this._steps.push({
        type: 'split',
        config: { splitter, splitterType: arg, pipeline: withVoidTarget(maybePipeline) },
      })
      return this as unknown as PipelineBuilder<unknown, O>
    }
    this._steps.push({ type: 'subflow', config: { pipeline: arg } })
    return this as unknown as PipelineBuilder<unknown, O>
  }

  /**
   * Push one `batch` step: the parsed `batch://` options plus the child pipeline that runs
   * once per package. The parent cardinality is unchanged — it continues with the members.
   */
  private batchSubflow(uri: string, pipeline: unknown): PipelineBuilder<I, O> {
    const op = batchOp(uri)
    const parsed = registry.parse(uri)
    if (BATCH_CHILD_VIEWS.has(`${parsed.host}${parsed.path}`)) {
      throw new TypeError(
        `${op}: '${uri}' is a child-side batch view and only works INSIDE a batch child — the batch itself is .subflow('batch://?size=5', pipe)`,
      )
    }
    const { size, slide } = parseBatchUri(uri)
    assertBatchPipeline(op, pipeline)
    this._steps.push({
      type: 'batch',
      config: { size, slide, pipeline: withBatchReturn(pipeline) },
    })
    return this
  }

  /**
   * Observe every envelope; the stream passes through unchanged.
   *
   * Synchronous callbacks are fine (the engine awaits the result, and `await`
   * on a non-promise is a no-op), so logging/metrics taps need no `async`.
   */
  tap(fn: (ex: Exchange<I>) => void | Promise<void>): PipelineBuilder<I, O> {
    this._steps.push({ type: 'tap', config: { fn } })
    return this
  }

  /**
   * Register a `before` interceptor: runs before every `.use()` tool invocation in this
   * pipeline (and its fork/subflow children, unless they register their own). May return a
   * (possibly modified) exchange to feed the tool instead of the incoming one, or void to
   * keep it. Throwing skips the tool invoke; the error follows the step's retry/error policy.
   * Registrations stack and run in registration order.
   */
  before(fn: BeforeInterceptor): PipelineBuilder<I, O> {
    this._interceptors.push({ kind: 'before', fn })
    return this
  }

  /**
   * Register an `after` interceptor: runs after every successful `.use()` tool invocation
   * only — never when the tool (or a `before`/`around` interceptor) failed, including after
   * retries are exhausted. May return a (possibly modified) exchange to pass downstream,
   * or void to keep the tool's output. Registrations stack and run in registration order.
   */
  after(fn: AfterInterceptor): PipelineBuilder<I, O> {
    this._interceptors.push({ kind: 'after', fn })
    return this
  }

  /**
   * Register an `around` interceptor: middleware-style wrapper around every `.use()` tool
   * invocation. `next` invokes the remaining around interceptors (onion-nested, the
   * first-registered is outermost) and finally the tool itself; the interceptor must return
   * the (possibly replaced) output exchange. Supports async work, timing, catching errors
   * and swapping exchanges. Registrations stack.
   */
  around(fn: AroundInterceptor): PipelineBuilder<I, O> {
    this._interceptors.push({ kind: 'around', fn })
    return this
  }

  /**
   * Log every envelope to the console; the stream passes through unchanged.
   *
   * Sugar over {@link tap} for debugging. Emits one standard log line per
   * envelope: `<ISO-ms> [<LEVEL>] [<label>] <exchange id> <item>`
   * (`label` defaults to the pipeline id; DSL level `log` maps to severity
   * `info`). Pass a string as shorthand for `{ label }`.
   */
  log(options?: string | LogOptions): PipelineBuilder<I, O> {
    const {
      label = this._id,
      level = 'log',
      truncate = true,
    } = typeof options === 'string' ? { label: options } : (options ?? {})
    const severity: LogSeverity = level === 'log' ? 'info' : level
    return this.tap((ex) => {
      log[severity](`[${label}] ${ex.id} ${renderLogItem(ex.item, truncate)}`)
    })
  }

  /**
   * Resolve a Source/Target given as an instance or a URI string into a step config.
   * Shared by {@link from} and {@link to} — only the step type and the registry lookup differ.
   */
  private resolveEndpoint<T>(
    endpoint: Source<T> | Target<T> | string,
    resolve: (uri: string) => { uri: string },
  ): { uri: string; instance?: Source<T> | Target<T> } {
    if (typeof endpoint === 'string' && registry.isAliasCandidate(endpoint)) {
      // Named URI alias — needs mt.json settings, so the Runner resolves it at run time
      return { uri: endpoint }
    }
    if (typeof endpoint !== 'string') {
      // Keep the instance: the Runner uses it instead of re-resolving the URI from the registry
      // (this is what lets `defineWaypoint` wrappers and custom Sources/Targets reach the actual run).
      return { uri: endpoint.uri, instance: endpoint }
    }
    return { uri: resolve(endpoint).uri }
  }
}

/**
 * Render an envelope item as a deterministic single-line string: strings pass
 * through (truncated if `truncate`), primitives via `String()`, objects via
 * compact `JSON.stringify` with a `String()` fallback. Newlines stay in the
 * value — `formatLogLine` escapes them.
 */
function renderLogItem(item: unknown, truncate: boolean): string {
  if (typeof item === 'string') return truncate ? truncateText(item) : item
  if (item === null || item === undefined) return String(item)
  const type = typeof item
  if (type !== 'object' && type !== 'function') return String(item)
  try {
    const json = JSON.stringify(item)
    return json ?? String(item)
  } catch {
    return String(item)
  }
}

/** DSL level used by `.log()`; `'log'` maps to severity `info`. */
export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

/** Max text length (chars) for `.log()` truncation: cut center, concat start + "..." + end, show length. */
export const LOG_TEXT_MAX_LENGTH = 200

/** Truncate text for logging: cut the center, concat start + "..." + end, and report the original length.
 * For text longer than `maxLength`, returns `<start>...<end> (length: N chars)`; otherwise returns the text unchanged. */
export function truncateText(text: string, maxLength: number = LOG_TEXT_MAX_LENGTH): string {
  if (text.length <= maxLength) return text
  const ellipsis = '...'
  const available = maxLength - ellipsis.length
  const half = Math.floor(available / 2)
  const start = text.slice(0, half)
  const end = text.slice(-Math.ceil(available / 2))
  return `${start}${ellipsis}${end} (length: ${text.length} chars)`
}

/**
 * A process-level installer: either a side-effect function or an object with
 * `install()`. Runs at pipeline-module load time (before the Runner starts), so
 * whatever it registers process-wide is active for every run in the process.
 * The LLM-mock installer (`mockLlm(...)` from `@mt/tools`) is the primary example.
 */
export type ProcessInstall = (() => void) | { install(): void }

/**
 * Entry point for process-level setup that wraps a pipeline definition:
 * `.install(...)` applies process-wide installers (mock LLM providers, …) at
 * module load, `.config({ env })` declares pipeline-scoped env defaults,
 * `.pipeline(p)` returns the pipeline (with the config attached) so the chain
 * can be the module's default export.
 *
 * Process form: `defineProcess(pipelines, { id? })` groups several pipelines
 * into one runnable entity. It runs them sync (sequential, declaration order)
 * by default; `.parallel(true)` returns a parallel-mode copy and
 * `await proc.run(ctx?, options?)` executes them (one Runner/run id each,
 * shared GlobalContext). See {@link Process}.
 *
 * ```ts
 * export default defineProcess()
 *   .install(mockLlm({ source: ['answer'] }))
 *   .config({ env: { MT_CHUNK_SIZE: '40' } })
 *   .pipeline(definePipeline().from('jsonl://./in.jsonl').use(myTool).to('md://./out'))
 * ```
 *
 * @example
 * // Process: run every pipeline, in parallel
 * export default defineProcess([pipelineA, pipelineB], { id: 'all' }).parallel(true)
 * ```
 */
export function defineProcess(): ProcessBuilder
export function defineProcess(
  pipelines: readonly Pipeline[],
  options?: ProcessOptions,
): ProcessBuilder
export function defineProcess(
  pipelines?: readonly Pipeline[],
  options?: ProcessOptions,
): ProcessBuilder {
  return new ProcessBuilder(pipelines, options)
}

/**
 * Process builder: process-level setup (`.install()`, `.config()`, terminal
 * `.pipeline()`) plus, when created with a pipelines array, runnable process
 * behavior (`.parallel(flag)`, `.run()`) — see {@link Process}.
 */
export class ProcessBuilder implements Process {
  private readonly _config: ProcessConfig = {}
  private readonly _pipelines?: Pipeline[]
  private readonly _mode: ProcessMode = 'sync'
  private readonly _processId: string = 'process'

  constructor(pipelines?: readonly Pipeline[], options?: ProcessOptions) {
    if (pipelines !== undefined) {
      if (!Array.isArray(pipelines) || pipelines.length === 0) {
        throw new TypeError('defineProcess: pipelines must be a non-empty array')
      }
      for (const [index, pipeline] of pipelines.entries()) {
        if (!isPipeline(pipeline)) {
          throw new TypeError(
            `defineProcess: pipelines[${index}] must be an object with a string id and a steps array`,
          )
        }
      }
      this._pipelines = [...pipelines]
      this._processId = options?.id ?? 'process'
      this._mode = options?.mode ?? 'sync'
      this.applyEnvDefaults()
    }
  }

  /** `'process'` for the runnable form (`defineProcess([...])`); `undefined` for setup-only builders. */
  get kind(): 'process' | undefined {
    return this._pipelines ? 'process' : undefined
  }
  /** Process id (runnable form only). */
  get id(): string {
    return this._processId
  }
  /** Defensive copy of the process pipelines (empty for setup-only builders). */
  get pipelines(): readonly Pipeline[] {
    return this._pipelines ?? []
  }
  /** Run mode; `'sync'` unless `.parallel(true)` was used. */
  get mode(): ProcessMode {
    return this._mode
  }

  /** Apply installers immediately (pipeline-module load time). Chainable. */
  install(...installs: ProcessInstall[]): ProcessBuilder {
    for (const install of installs) {
      if (typeof install === 'function') install()
      else install.install()
    }
    return this
  }

  /**
   * Declare pipeline-scoped env defaults. Repeated calls merge; later values win.
   * Defaults never override `process.env` or the mt.json env at run time.
   */
  config(config: ProcessConfig): ProcessBuilder {
    if (config.env) {
      this._config.env = { ...this._config.env, ...config.env }
      this.applyEnvDefaults()
    }
    return this
  }

  /** Terminal step: returns the pipeline as-is (with env defaults attached) for the default export. */
  pipeline<P extends Pipeline<unknown, unknown>>(pipeline: P): P {
    this.applyEnvDefaults(pipeline)
    return pipeline
  }

  /**
   * Return a new builder with the same id/pipelines/env; `flag` (default
   * `true`) selects parallel mode, `false` sync. The original is unchanged.
   */
  parallel(flag = true): ProcessBuilder {
    const next = new ProcessBuilder(this._pipelines, {
      id: this._processId,
      mode: flag ? 'parallel' : 'sync',
    })
    if (this._config.env) next._config.env = { ...this._config.env }
    return next
  }

  /**
   * Run every pipeline of this process: one Runner/run id each, sharing one
   * GlobalContext. Sync mode (default) runs sequentially in declaration order
   * and stops on the first failure; parallel mode starts every Runner and
   * awaits `Promise.all` (a failure rejects the run). Without a context
   * argument the global context is loaded from `process.cwd()`.
   */
  async run(globalContext?: GlobalContext, options?: ProcessRunOptions): Promise<void> {
    const pipelines = this._pipelines
    if (!pipelines) {
      throw new Error(
        'defineProcess().run(): no pipelines to run — use the process form defineProcess([...])',
      )
    }
    const ctx = globalContext ?? (await loadGlobalContext(process.cwd()))

    const runOne = async (pipeline: Pipeline): Promise<void> => {
      const runner = new Runner(pipeline, ctx, options)
      const started = runner.start()
      options?.onRunner?.(runner, pipeline)
      await started
    }

    if (this._mode === 'parallel') {
      await Promise.all(pipelines.map(runOne))
      return
    }

    for (const pipeline of pipelines) {
      await runOne(pipeline)
    }
  }

  /** Attach the declared env defaults to one pipeline (or every process pipeline). */
  private applyEnvDefaults(only?: Pipeline): void {
    const env = this._config.env
    if (!env) return
    if (only) {
      only.envDefaults = { ...only.envDefaults, ...env }
      return
    }
    for (const pipeline of this._pipelines ?? []) {
      pipeline.envDefaults = { ...pipeline.envDefaults, ...env }
    }
  }
}

/** Type guard for a pipeline-shaped object (`id` string + `steps` array). */
export function isPipeline(value: unknown): value is Pipeline {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Partial<Pipeline>
  return typeof candidate.id === 'string' && Array.isArray(candidate.steps)
}

/**
 * Define a tool.
 */
export function defineTool<I, O>(config: {
  name: string
  version: string
  description: string
  invoke: (ex: Exchange<I>, ctx: ToolContext) => Promise<Exchange<O>>
  cacheable?: boolean
  idempotent?: boolean
  /** Runtime annotations (`tool(...)`, `useCase(...)`) attached to the returned Tool. */
  annotations?: readonly Annotation[]
  /** Declared inputs/outputs of the tool (item/meta/variable). */
  args?: readonly ToolArg[]
}): Tool<I, O> {
  const created: Tool<I, O> = {
    name: config.name,
    version: config.version,
    description: config.description,
    invoke: config.invoke,
    cacheable: config.cacheable,
    idempotent: config.idempotent,
    args: config.args,
  }
  return annotate(created, ...(config.annotations ?? []))
}

/**
 * Define a source from a URI string.
 * Resolves the URI via the registry to find the appropriate source implementation.
 */
export function defineSource<T>(uri: string): Source<T> {
  return registry.resolveSource<T>(uri)
}

/**
 * Define a target from a URI string.
 * Resolves the URI via the registry to find the appropriate target implementation.
 */
export function defineTarget<T>(uri: string): Target<T> {
  return registry.resolveTarget<T>(uri)
}

/**
 * Shorthand: source(uri) — calls defineSource.
 */
export function source<T>(uri: string): Source<T> {
  return defineSource<T>(uri)
}

/**
 * Compose a new Source from an existing Source (or URI string), adding
 * lifecycle/filter hooks around it. The wrapper passes `uri` and `lifestyle`
 * through unchanged, and exposes `resume` only when the inner source has one.
 *
 * @example
 * // Keep only chapters matching a predicate, wrap any jsonl:// input
 * const filtered = defineWaypoint<Chapter>('jsonl://./chapters.jsonl', {
 *   filter: (env) => env.item.title.startsWith('Part 1:'),
 * })
 */
export function defineWaypoint<T>(
  base: Source<T> | string,
  hooks: WaypointSourceHooks<T>,
): Source<T>
/**
 * Compose a new Target from an existing Target (or URI string), adding
 * lifecycle/filter hooks around it. The inner `checkpoint(ctx)` hook is
 * forwarded ONLY when the inner target implements it — the wrapper never
 * invents one (targets that commit atomically on close must stay checkpoint-less).
 */
export function defineWaypoint<T>(
  base: Target<T> | string,
  hooks: WaypointTargetHooks<T>,
): Target<T>
export function defineWaypoint<T>(
  base: Source<T> | Target<T> | string,
  hooks: WaypointSourceHooks<T> & WaypointTargetHooks<T>,
): Source<T> | Target<T> {
  const inner = resolveWaypointBase<T>(base)
  if (typeof (inner as Source<T>).start === 'function') {
    return wrapWaypointSource(inner as Source<T>, hooks)
  }
  return wrapWaypointTarget(inner as Target<T>, hooks)
}

/**
 * Resolve a `base` argument: strings try `resolveSource` first and fall back
 * to `resolveTarget`; instances pass through.
 */
function resolveWaypointBase<T>(base: Source<T> | Target<T> | string): Source<T> | Target<T> {
  if (typeof base !== 'string') return base
  try {
    return registry.resolveSource<T>(base)
  } catch {
    return registry.resolveTarget<T>(base)
  }
}

/** Wrap a Source with `WaypointSourceHooks`; `resume` exists only if the inner source has one. */
function wrapWaypointSource<T>(inner: Source<T>, hooks: WaypointSourceHooks<T>): Source<T> {
  const wrapper: Source<T> = {
    uri: inner.uri,
    lifestyle: inner.lifestyle,
    async *start(ctx: SourceContext): AsyncIterable<ExchangeInput<T>> {
      await hooks.onStart?.(ctx)
      for await (const raw of inner.start(ctx)) {
        const env = toExchange(raw)
        if (hooks.filter && !(await hooks.filter(env))) continue
        await hooks.onItem?.(env)
        yield env
      }
    },
  }
  const innerResume = inner.resume
  if (innerResume) {
    wrapper.resume = async function* (
      ctx: SourceContext,
      cursor: unknown,
    ): AsyncIterable<ExchangeInput<T>> {
      for await (const raw of innerResume.call(inner, ctx, cursor)) {
        const env = toExchange(raw)
        if (hooks.filter && !(await hooks.filter(env))) continue
        await hooks.onItem?.(env)
        yield env
      }
    }
  }
  return wrapper
}

/** Wrap a Target with `WaypointTargetHooks`; forwards `checkpoint` only if the inner target has it. */
function wrapWaypointTarget<T>(inner: Target<T>, hooks: WaypointTargetHooks<T>): Target<T> {
  const wrapper: Target<T> = {
    uri: inner.uri,
    async open(ctx: TargetContext): Promise<void> {
      await inner.open(ctx)
      await hooks.onOpen?.(ctx)
    },
    async write(env: Exchange<T>, ctx: TargetContext): Promise<void> {
      if (hooks.filter && !(await hooks.filter(env))) return
      await inner.write(env, ctx)
      await hooks.onWrite?.(env)
    },
    async close(ctx: TargetContext): Promise<void> {
      await inner.close(ctx)
      await hooks.onClose?.(ctx)
    },
  }
  const innerCheckpoint = inner.checkpoint
  if (innerCheckpoint) {
    wrapper.checkpoint = (ctx: TargetContext) => innerCheckpoint.call(inner, ctx)
  }
  return wrapper
}

/**
 * Shorthand: target(uri) — calls defineTarget.
 */
export function target<T>(uri: string): Target<T> {
  return defineTarget<T>(uri)
}

/** A plain function usable wherever a slot Tool is expected. */
export type ToolFn<I = unknown, O = unknown> = (
  ex: Exchange<I>,
  ctx: ToolContext,
) => Promise<Exchange<O>>

/**
 * Compose tools into one sequential Tool: each tool's output envelope feeds the next.
 * Result is a plain Tool, so `.use(chain(...))` works unchanged.
 */
export function chain<I = unknown, O = unknown>(
  name: string,
  ...tools: Array<Tool<never, unknown> | Tool<unknown, unknown>>
): Tool<I, O> {
  const steps = tools as Tool<unknown, unknown>[]
  return defineTool<I, O>({
    name,
    version: '1.0.0',
    description: `Chain: ${steps.map((t) => t.name).join(' -> ')}`,
    async invoke(ex, ctx) {
      let current = ex as unknown as Exchange<unknown>
      for (const tool of steps) current = await tool.invoke(current, ctx)
      return current as unknown as Exchange<O>
    },
  })
}

/**
 * Define a tool as sequential slots (object key order = execution order).
 * Pipeline authors swap parts via `tool.with({ slot: otherTool | fn })`.
 */
export function defineComposableTool<I, O, S extends string>(config: {
  name: string
  version: string
  description: string
  slots: Record<S, Tool<never, unknown> | Tool<unknown, unknown>>
}): ComposableTool<I, O, S> {
  const slots = Object.freeze({ ...config.slots }) as ComposableTool<I, O, S>['slots']
  const names = Object.keys(slots) as S[]
  const base = defineTool<I, O>({
    name: config.name,
    version: config.version,
    description: config.description,
    async invoke(ex, ctx) {
      let current = ex as unknown as Exchange<unknown>
      for (const key of names) {
        current = await (slots[key] as Tool<unknown, unknown>).invoke(current, ctx)
      }
      return current as unknown as Exchange<O>
    },
  })
  return {
    ...base,
    slots,
    with(overrides) {
      const next = { ...slots } as Record<S, Tool<never, unknown> | Tool<unknown, unknown>>
      for (const key of Object.keys(overrides) as S[]) {
        const repl = overrides[key]
        if (repl === undefined) continue
        if (!(key in slots)) {
          throw new Error(`Tool '${config.name}' has no slot '${key}' (slots: ${names.join(', ')})`)
        }
        if (typeof repl === 'function') {
          next[key] = defineTool<unknown, unknown>({
            name: `${config.name}:${key}`,
            version: config.version,
            description: `Override of slot '${key}'`,
            invoke: repl as ToolFn,
          })
        } else {
          next[key] = repl as Tool<unknown, unknown>
        }
      }
      return defineComposableTool<I, O, S>({ ...config, slots: next })
    },
  }
}
