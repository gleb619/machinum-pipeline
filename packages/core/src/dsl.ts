import { basename, dirname } from 'node:path'
import type { ToolContext } from './contexts.js'
import type { Envelope, Pipeline, PipelineStep, Source, Target, Tool } from './types.js'
import { registry } from './uri.js'

/**
 * Default retry configuration
 */
const DEFAULT_RETRY = { max: 3, backoffMs: 1000, strategy: 'exp' as const }
const DEFAULT_ON_ERROR: 'fail-run' | 'skip-item' | 'dead-letter' = 'fail-run'

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
        // Extract filename without extension
        const base = basename(fileName, '.ts')
        // Skip index files, use parent directory name if it's a common pattern
        if (base === 'index' || base === 'pipeline') {
          const dirName = basename(dirname(fileName))
          return dirName
        }
        return base
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
  retry?: { max: number; backoffMs: number; strategy: 'fixed' | 'linear' | 'exp' }
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
  private readonly _retry: { max: number; backoffMs: number; strategy: 'fixed' | 'linear' | 'exp' }
  private readonly _onError: 'fail-run' | 'skip-item' | 'dead-letter'
  private readonly _steps: PipelineStep[] = []

  get id(): string {
    return this._id
  }
  get retry(): { max: number; backoffMs: number; strategy: 'fixed' | 'linear' | 'exp' } {
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
    retry: { max: number; backoffMs: number; strategy: 'fixed' | 'linear' | 'exp' }
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
      retry?: { max?: number; backoffMs?: number; strategy?: 'fixed' | 'linear' | 'exp' }
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

  batch(size: number): PipelineBuilder<I[], O> {
    this._steps.push({ type: 'batch', config: { size } })
    return this as unknown as PipelineBuilder<I[], O>
  }

  window(size: number): PipelineBuilder<I[], O> {
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

  tap(fn: (item: I) => Promise<void>): PipelineBuilder<I, O> {
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
  invoke: (env: Envelope<I>, ctx: ToolContext) => Promise<Envelope<O>>
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
 * Shorthand: target(uri) — calls defineTarget.
 */
export function target<T>(uri: string): Target<T> {
  return defineTarget<T>(uri)
}

/** A plain function usable wherever a slot Tool is expected. */
export type ToolFn<I = unknown, O = unknown> = (
  env: Envelope<I>,
  ctx: ToolContext,
) => Promise<Envelope<O>>

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
    async invoke(env, ctx) {
      let current = env as unknown as Envelope<unknown>
      for (const tool of steps) current = await tool.invoke(current, ctx)
      return current as unknown as Envelope<O>
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
    async invoke(env, ctx) {
      let current = env as unknown as Envelope<unknown>
      for (const key of names) {
        current = await (slots[key] as Tool<unknown, unknown>).invoke(current, ctx)
      }
      return current as unknown as Envelope<O>
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
