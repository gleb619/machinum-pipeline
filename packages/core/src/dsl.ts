import { basename, dirname } from 'node:path'
import { type Annotation, annotate } from './annotation.js'
import { loadGlobalContext } from './config.js'
import type {
  GlobalContext,
  RetryPolicy,
  SourceContext,
  TargetContext,
  ToolContext,
} from './contexts.js'
import { Runner } from './engine/runner.js'
import { type Exchange, type ExchangeInput, toExchange } from './exchange.js'
import type { PipelineSuite, PipelineSuiteMode, ProcessRunOptions } from './suite.js'
import { isPipeline } from './suite.js'
import type { Pipeline, PipelineStep, Source, Target, Tool } from './types.js'
import { registry } from './uri.js'

/**
 * Default retry configuration
 */
const DEFAULT_RETRY = { max: 3, backoffMs: 1000, strategy: 'exp' as const }
const DEFAULT_ON_ERROR: 'fail-run' | 'skip-item' | 'dead-letter' = 'fail-run'

/** Options of `.batch()`. */
export interface BatchOptions {
  /** Positive integer package size. Default {@link DEFAULT_BATCH_SIZE}. */
  size?: number
  /** Sliding windows (one overlapping package per arrival) instead of tumbling. Default `false`. */
  slide?: boolean
}

/** Default `.batch()` package size. */
export const DEFAULT_BATCH_SIZE = 5

/**
 * Normalize + validate `.batch()` options: size must be a positive integer.
 * Throws at pipeline-definition time so a bad size never reaches the Runner.
 */
function normalizeBatchOptions(opts: BatchOptions | number | undefined): Required<BatchOptions> {
  const o: BatchOptions = typeof opts === 'number' ? { size: opts } : (opts ?? {})
  const size = o.size ?? DEFAULT_BATCH_SIZE
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`.batch(size): size must be a positive integer, got ${size}`)
  }
  return { size, slide: o.slide ?? false }
}

let warnedAboutPipelineId = false

/** One-shot warning: pipeline ids cannot be inferred from the stack under bun. */
function warnUnresolvablePipelineId(): void {
  if (warnedAboutPipelineId) return
  warnedAboutPipelineId = true
  console.warn(
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
 * Also supports .fork(), .subflow(), .flatMap(), .batch(), .tap(), .log()
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
    if (typeof source === 'string' && registry.isAliasCandidate(source)) {
      // Named URI alias — needs mt.json settings, so the Runner resolves it at run time
      this._steps.push({ type: 'source', config: { uri: source } })
      return this as unknown as PipelineBuilder<T, O>
    }
    if (typeof source !== 'string') {
      // Keep the instance: the Runner uses it instead of re-resolving the URI from the registry
      // (this is what lets `defineWaypoint` wrappers and custom Sources reach the actual run).
      this._steps.push({ type: 'source', config: { uri: source.uri, instance: source } })
      return this as unknown as PipelineBuilder<T, O>
    }
    const resolvedSource = registry.resolveSource<T>(source)
    this._steps.push({ type: 'source', config: { uri: resolvedSource.uri } })
    return this as unknown as PipelineBuilder<T, O>
  }

  /** Sugar: `.use()` each tool in order (same as chaining `.use()` calls). */
  useAll(...tools: Tool<never, unknown>[]): PipelineBuilder<unknown, O> {
    for (const tool of tools) this.use(tool as Tool<unknown, unknown>)
    return this as unknown as PipelineBuilder<unknown, O>
  }

  use<T, R>(
    tool: Tool<T, R>,
    overrides?: {
      retry?: Partial<RetryPolicy>
      onError?: 'fail-run' | 'skip-item' | 'dead-letter'
    },
  ): PipelineBuilder<R, O> {
    this._steps.push({
      type: 'tool',
      config: {
        name: tool.name,
        version: tool.version,
        tool,
        retry: overrides?.retry,
        onError: overrides?.onError,
      },
    })
    return this as unknown as PipelineBuilder<R, O>
  }

  /**
   * Set the target for the pipeline.
   * Ends the stage — the builder doubles as the completed Pipeline. A further `.from()` starts
   * the next stage (used by `.batch(opts, nested)` scopes: group stage, then members stage).
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
    if (typeof target === 'string' && registry.isAliasCandidate(target)) {
      // Named URI alias — needs mt.json settings, so the Runner resolves it at run time
      this._steps.push({ type: 'target', config: { uri: target } })
      return this
    }
    if (typeof target !== 'string') {
      // Keep the instance: the Runner uses it instead of re-resolving the URI from the registry
      // (this is what lets `defineWaypoint` wrappers and custom Targets reach the actual run).
      this._steps.push({ type: 'target', config: { uri: target.uri, instance: target } })
      return this
    }
    const resolvedTarget = registry.resolveTarget<T>(target)
    this._steps.push({ type: 'target', config: { uri: resolvedTarget.uri } })
    return this
  }

  /**
   * Group envelopes into packages of `size` (default 5), flushing the remainder at end of stream.
   *
   * Without `nested` the stream continues with ONE grouped envelope per package (`item` =
   * `items[]`, members carried). With a `nested` pipeline each package runs through it (a batch
   * SCOPE) and the outer stream continues with the original member envelopes, patched by
   * whatever the scope committed. Inside the scope, pick the view with waypoints:
   *
   * - `batch://group`   source: the package as ONE exchange
   * - `batch://members` source: every member as its own exchange
   * - `batch://return`  target: hand a result back to the scope (group: its variable edits
   *   reach every member; member: replaces that member by id)
   *
   * A scope may chain stages (`.to('batch://return').from('batch://members')...`).
   *
   * @param opts - Size (positive integer) or `{ size?, slide? }`; anything else throws
   *   `RangeError` here. `slide: true` makes overlapping sliding windows (one per arrival) and
   *   cannot be combined with a nested scope.
   * @param nested - Pipeline run per package (defined with `definePipeline()`). `.batch(nested)`
   *   alone uses the default size.
   */
  batch(nested: Pipeline<unknown, unknown>): PipelineBuilder<I[], O>
  batch(opts?: BatchOptions | number, nested?: Pipeline<unknown, unknown>): PipelineBuilder<I[], O>
  batch(
    optsOrNested?: BatchOptions | number | Pipeline<unknown, unknown>,
    maybeNested?: Pipeline<unknown, unknown>,
  ): PipelineBuilder<I[], O> {
    const isNested = typeof optsOrNested === 'object' && 'steps' in optsOrNested
    const opts = isNested ? undefined : (optsOrNested as BatchOptions | number | undefined)
    const nested = isNested ? (optsOrNested as Pipeline<unknown, unknown>) : maybeNested
    const { size, slide } = normalizeBatchOptions(opts)
    if (nested && slide) {
      throw new RangeError(
        '.batch(opts, nested): slide:true cannot be combined with a nested scope',
      )
    }
    this._steps.push({
      type: 'batch',
      config: nested ? { size, slide, pipeline: nested } : { size, slide },
    })
    return this as unknown as PipelineBuilder<I[], O>
  }

  flatMap<R>(fn: (item: I) => Promise<R[]>): PipelineBuilder<R, O> {
    this._steps.push({ type: 'flatmap', config: { fn } })
    return this as unknown as PipelineBuilder<R, O>
  }

  /**
   * Fork the stream into a child pipeline per envelope (sequential), or into several
   * concurrently running branches per envelope (parallel).
   *
   * The sequential form is unchanged: each parent envelope runs the child pipeline and
   * its output is merged back in arrival order. The parallel form validates `name` and
   * `branches` at definition time; the Runner then runs every branch concurrently and
   * merges their buffered output in branch declaration order.
   */
  fork(pipeline: Pipeline<I, unknown>): PipelineBuilder<I, O>
  fork(name: string, branches: readonly Pipeline[]): PipelineBuilder<I, O>
  fork(
    pipelineOrName: Pipeline<I, unknown> | string,
    branches?: readonly Pipeline[],
  ): PipelineBuilder<I, O> {
    if (typeof pipelineOrName === 'string') {
      if (pipelineOrName.trim().length === 0) {
        throw new TypeError('.fork(name, branches): name must be a non-empty string')
      }
      if (!Array.isArray(branches) || branches.length === 0) {
        throw new TypeError(
          '.fork(name, branches): branches must be a non-empty array of pipelines',
        )
      }
      for (const [index, branch] of branches.entries()) {
        if (!isPipeline(branch)) {
          throw new TypeError(
            `.fork(name, branches): branches[${index}] must be an object with a string id and a steps array`,
          )
        }
      }
      this._steps.push({
        type: 'fork',
        config: { name: pipelineOrName, pipelines: [...branches], parallel: true },
      })
      return this
    }
    this._steps.push({ type: 'fork', config: { pipeline: pipelineOrName } })
    return this
  }

  /**
   * Run an inline sub-pipeline, or split the current stream by an entity/buffer type.
   *
   * Pipeline form: inline nested pipeline in the same Runner (a steps-only child is spliced
   * into the parent stream; a child with its own source is self-contained).
   *
   * String form: resolve the registered `Splitter` for that entity/buffer URI scheme and
   * fan out 1 → N. For example `.subflow('paragraphs://')` (or `'#paragraphs'`) splits chunks
   * into paragraphs and `.subflow('lines://')` splits paragraphs into lines. Accepts a buffer
   * URI (`'paragraphs://'` / `'paragraphs://ladder'`) or the `#scheme` shortcut; a bare
   * `'paragraphs'` is rejected. The splitter receives the full Exchange.
   *
   * `.fork()` is per-envelope child-Runner nesting (or one child per branch in the parallel
   * form), not a split: it is too heavy for a plain 1 → N transformation.
   */
  subflow(pipeline: Pipeline<I, unknown>): PipelineBuilder<I, O>
  subflow(splitterType: string): PipelineBuilder<unknown, O>
  subflow(arg: Pipeline<I, unknown> | string): PipelineBuilder<unknown, O> {
    if (typeof arg === 'string') {
      const splitter = registry.resolveSplitter<unknown>(arg)
      this._steps.push({ type: 'split', config: { splitter, splitterType: arg } })
      return this as unknown as PipelineBuilder<unknown, O>
    }
    this._steps.push({ type: 'subflow', config: { pipeline: arg } })
    return this as unknown as PipelineBuilder<unknown, O>
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
   * Log every envelope to the console; the stream passes through unchanged.
   *
   * Sugar over {@link tap} for debugging. Each call prints `[<label>] <exchange id> <item>`
   * (`label` defaults to the pipeline id). Pass a string as shorthand for `{ label }`.
   */
  log(options?: string | LogOptions): PipelineBuilder<I, O> {
    const { label = this._id, level = 'log', truncate = false } =
      typeof options === 'string' ? { label: options } : (options ?? {})
    return this.tap((ex) => {
      console[level](
        `[${label}]`,
        ex.id,
        truncate ? truncateText(ex.item as string) : ex.item,
      )
    })
  }
}

/** Console method used by `.log()`. */
export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

/** Options of `.log()`. */
export interface LogOptions {
  /** Prefix for each line. Defaults to the pipeline id. */
  label?: string
  /** Console method to call. Default `'log'`. */
  level?: LogLevel
  /** If `true`, truncate long text to `LOG_TEXT_MAX_LENGTH` chars (start + "..." + end + length). */
  truncate?: boolean
}

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
 * Process-level configuration for a pipeline module. `env` entries are defaults:
 * the Runner applies them to the run env only for keys not already set in
 * `process.env` or the mt.json env, so real environment variables always win.
 */
export interface ProcessConfig {
  env?: Record<string, string>
}

/**
 * Options for `defineProcess(pipelines, options?)` (suite form).
 */
export interface ProcessSuiteOptions {
  /** Suite id used in CLI logs. Default `'pipeline-suite'`. */
  id?: string
  /** Run mode. Default `'sync'`; prefer `.parallel(true)` over this. */
  mode?: PipelineSuiteMode
}

/**
 * Entry point for process-level setup that wraps a pipeline definition:
 * `.install(...)` applies process-wide installers (mock LLM providers, …) at
 * module load, `.config({ env })` declares pipeline-scoped env defaults,
 * `.pipeline(p)` returns the pipeline (with the config attached) so the chain
 * can be the module's default export.
 *
 * Suite form: `defineProcess(pipelines, { id? })` groups several pipelines
 * into one runnable entity. It runs them sync (sequential, declaration order)
 * by default; `.parallel(true)` returns a parallel-mode copy and
 * `await proc.run(ctx?, options?)` executes them (one Runner/run id each,
 * shared GlobalContext). See {@link PipelineSuite}.
 *
 * ```ts
 * export default defineProcess()
 *   .install(mockLlm({ source: ['answer'] }))
 *   .config({ env: { MT_CHUNK_SIZE: '40' } })
 *   .pipeline(definePipeline().from('jsonl://./in.jsonl').use(myTool).to('md://./out'))
 * ```
 *
 * @example
 * // Suite: run every pipeline, in parallel
 * export default defineProcess([pipelineA, pipelineB], { id: 'all' }).parallel(true)
 * ```
 */
export function defineProcess(): ProcessBuilder
export function defineProcess(
  pipelines: readonly Pipeline[],
  options?: ProcessSuiteOptions,
): ProcessBuilder
export function defineProcess(
  pipelines?: readonly Pipeline[],
  options?: ProcessSuiteOptions,
): ProcessBuilder {
  return new ProcessBuilder(pipelines, options)
}

/**
 * Process builder: process-level setup (`.install()`, `.config()`, terminal
 * `.pipeline()`) plus, when created with a pipelines array, suite behavior
 * (`.parallel(flag)`, `.run()`) — see {@link PipelineSuite}.
 */
export class ProcessBuilder implements PipelineSuite {
  private readonly _config: ProcessConfig = {}
  private readonly _pipelines?: Pipeline[]
  private readonly _mode: PipelineSuiteMode = 'sync'
  private readonly _suiteId: string = 'pipeline-suite'

  constructor(pipelines?: readonly Pipeline[], options?: ProcessSuiteOptions) {
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
      this._suiteId = options?.id ?? 'pipeline-suite'
      this._mode = options?.mode ?? 'sync'
      this.applyEnvDefaults()
    }
  }

  /** `'pipeline-suite'` for the suite form (`defineProcess([...])`); `undefined` for setup-only builders. */
  get kind(): 'pipeline-suite' | undefined {
    return this._pipelines ? 'pipeline-suite' : undefined
  }
  /** Suite id (suite form only). */
  get id(): string {
    return this._suiteId
  }
  /** Defensive copy of the suite pipelines (empty for setup-only builders). */
  get pipelines(): readonly Pipeline[] {
    return this._pipelines ?? []
  }
  /** Run mode; `'sync'` unless `.parallel(true)` was used. */
  get mode(): PipelineSuiteMode {
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
      id: this._suiteId,
      mode: flag ? 'parallel' : 'sync',
    })
    if (this._config.env) next._config.env = { ...this._config.env }
    return next
  }

  /**
   * Run every pipeline of the suite in this process: one Runner/run id each,
   * sharing one GlobalContext. Sync mode (default) runs sequentially in
   * declaration order and stops on the first failure; parallel mode starts
   * every Runner and awaits `Promise.all` (a failure rejects the run).
   * Without a context argument the global context is loaded from `process.cwd()`.
   */
  async run(globalContext?: GlobalContext, options?: ProcessRunOptions): Promise<void> {
    const pipelines = this._pipelines
    if (!pipelines) {
      throw new Error(
        'defineProcess().run(): no pipelines to run — use the suite form defineProcess([...])',
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

  /** Attach the declared env defaults to one pipeline (or every suite pipeline). */
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

/**
 * Define a tool.
 */
export function defineTool<I, O>(config: {
  name: string
  version: string
  mdDescription: string
  invoke: (ex: Exchange<I>, ctx: ToolContext) => Promise<Exchange<O>>
  cacheable?: boolean
  idempotent?: boolean
  /** Runtime annotations (`tool(...)`, `useCase(...)`) attached to the returned Tool. */
  annotations?: readonly Annotation[]
}): Tool<I, O> {
  const created: Tool<I, O> = {
    name: config.name,
    version: config.version,
    mdDescription: config.mdDescription,
    invoke: config.invoke,
    cacheable: config.cacheable,
    idempotent: config.idempotent,
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
 * Hooks for a `defineWaypoint` source wrapper — compose a new Source from an
 * existing one (instance or URI string) without writing a new class.
 */
export interface WaypointSourceHooks<T> {
  /** Called once before the inner source starts yielding. */
  onStart?: (ctx: SourceContext) => void | Promise<void>
  /** Return false to drop an envelope from the stream (hardcoded-style filters). */
  filter?: (env: Exchange<T>) => boolean | Promise<boolean>
  /** Called for every envelope that passes the filter (observation tap). */
  onItem?: (env: Exchange<T>) => void | Promise<void>
}

/**
 * Hooks for a `defineWaypoint` target wrapper — compose a new Target from an
 * existing one (instance or URI string) without writing a new class.
 */
export interface WaypointTargetHooks<T> {
  onOpen?: (ctx: TargetContext) => void | Promise<void>
  /** Return false to skip writing this envelope to the inner target. */
  filter?: (env: Exchange<T>) => boolean | Promise<boolean>
  /** Called after the inner target accepted the envelope (only for written ones). */
  onWrite?: (env: Exchange<T>) => void | Promise<void>
  onClose?: (ctx: TargetContext) => void | Promise<void>
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
    mdDescription: `Chain: ${steps.map((t) => t.name).join(' -> ')}`,
    async invoke(ex, ctx) {
      let current = ex as unknown as Exchange<unknown>
      for (const tool of steps) current = await tool.invoke(current, ctx)
      return current as unknown as Exchange<O>
    },
  })
}

/**
 * Tool made of named, ordered slots (each slot is itself a Tool). `.with()` returns a NEW
 * tool with some slots replaced - the original is never mutated.
 */
export interface ComposableTool<I = unknown, O = unknown, S extends string = string>
  extends Tool<I, O> {
  readonly slots: Readonly<Record<S, Tool<never, unknown> | Tool<unknown, unknown>>>
  with(
    overrides: Partial<Record<S, Tool<never, unknown> | Tool<unknown, unknown> | ToolFn>>,
  ): ComposableTool<I, O, S>
}

/**
 * Define a tool as sequential slots (object key order = execution order).
 * Pipeline authors swap parts via `tool.with({ slot: otherTool | fn })`.
 */
export function defineComposableTool<I, O, S extends string>(config: {
  name: string
  version: string
  mdDescription: string
  slots: Record<S, Tool<never, unknown> | Tool<unknown, unknown>>
}): ComposableTool<I, O, S> {
  const slots = Object.freeze({ ...config.slots }) as ComposableTool<I, O, S>['slots']
  const names = Object.keys(slots) as S[]
  const base = defineTool<I, O>({
    name: config.name,
    version: config.version,
    mdDescription: config.mdDescription,
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
            mdDescription: `Override of slot '${key}'`,
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
