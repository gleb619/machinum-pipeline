import { basename, dirname } from 'node:path'
import type { RetryPolicy, SourceContext, TargetContext, ToolContext } from './contexts.js'
import type { Exchange } from './exchange.js'
import type { Pipeline, PipelineStep, Source, Target, Tool } from './types.js'
import { registry } from './uri.js'

/**
 * Default retry configuration
 */
const DEFAULT_RETRY = { max: 3, backoffMs: 1000, strategy: 'exp' as const }
const DEFAULT_ON_ERROR: 'fail-run' | 'skip-item' | 'dead-letter' = 'fail-run'

/**
 * Validate a `.batch()` / `.window()` size: must be a positive integer.
 * Throws at pipeline-definition time so a bad size never reaches the Runner.
 */
function assertPositiveInt(size: number, op: 'batch' | 'window'): void {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`.${op}(size): size must be a positive integer, got ${size}`)
  }
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
 * Also supports .fork(), .subflow(), .flatMap(), .batch(), .window(), .tap()
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
    const resolvedSource = typeof source === 'string' ? registry.resolveSource<T>(source) : source
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
   * Terminates the builder — returns the completed Pipeline.
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
  to<T>(target: Target<T> | string): Pipeline<I, O> {
    if (typeof target === 'string' && registry.isAliasCandidate(target)) {
      // Named URI alias — needs mt.json settings, so the Runner resolves it at run time
      this._steps.push({ type: 'target', config: { uri: target } })
      return this
    }
    const resolvedTarget = typeof target === 'string' ? registry.resolveTarget<T>(target) : target
    this._steps.push({ type: 'target', config: { uri: resolvedTarget.uri } })
    return this
  }

  /**
   * Group envelopes into `items[]` batches of `size`, flushing the remainder at end of stream.
   *
   * @param size - Positive integer batch size; anything else throws `RangeError` here.
   */
  batch(size: number): PipelineBuilder<I[], O> {
    assertPositiveInt(size, 'batch')
    this._steps.push({ type: 'batch', config: { size } })
    return this as unknown as PipelineBuilder<I[], O>
  }

  /**
   * Group envelopes into `items[]` sliding windows of `size` (one item per arrival).
   *
   * @param size - Positive integer window size; anything else throws `RangeError` here.
   */
  window(size: number): PipelineBuilder<I[], O> {
    assertPositiveInt(size, 'window')
    this._steps.push({ type: 'window', config: { size } })
    return this as unknown as PipelineBuilder<I[], O>
  }

  flatMap<R>(fn: (item: I) => Promise<R[]>): PipelineBuilder<R, O> {
    this._steps.push({ type: 'flatmap', config: { fn } })
    return this as unknown as PipelineBuilder<R, O>
  }

  fork(pipeline: Pipeline<I, unknown>): PipelineBuilder<I, O> {
    this._steps.push({ type: 'fork', config: { pipeline } })
    return this
  }

  subflow(pipeline: Pipeline<I, unknown>): PipelineBuilder<I, O> {
    this._steps.push({ type: 'subflow', config: { pipeline } })
    return this
  }

  tap(fn: (ex: Exchange<I>) => Promise<void>): PipelineBuilder<I, O> {
    this._steps.push({ type: 'tap', config: { fn } })
    return this
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
}): Tool<I, O> {
  return {
    name: config.name,
    version: config.version,
    mdDescription: config.mdDescription,
    invoke: config.invoke,
    cacheable: config.cacheable,
    idempotent: config.idempotent,
  }
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
    async *start(ctx: SourceContext): AsyncIterable<Exchange<T>> {
      await hooks.onStart?.(ctx)
      for await (const env of inner.start(ctx)) {
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
    ): AsyncIterable<Exchange<T>> {
      for await (const env of innerResume.call(inner, ctx, cursor)) {
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
