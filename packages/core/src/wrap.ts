import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Compose a tool (or any function) as a chain of small named stages.
 *
 * `wrap(name, ...stages)` builds an async callable that runs its stages
 * sequentially, feeding each stage's output to the next. It is generic over
 * the payload — usable inside a tool's `invoke` on `ex.item`, but not coupled
 * to {@link Exchange}:
 *
 * ```ts
 * invoke: (ex, ctx) => wrap<ChapterDoc, ChapterDoc, ToolContext>(
 *   'chapter-doc',
 *   defineStage('parse', (doc, ctx) => parse(doc)),
 *   defineStage('emit', (doc, ctx) => emit(doc, ctx)),
 * )(ex.item, ctx)
 * ```
 *
 * Every stage of every invocation passes through the chain's interceptors
 * (registered with `.intercept(...)`), so callers can observe, metric and
 * checkpoint INSIDE a tool, not just between tools. The hook payload carries
 * the raw data a metrics recorder or checkpoint needs: stage path, index,
 * input/output refs, `startedAt`, `durationMs`, `outcome`, `error`.
 *
 * Nested chains (a stage fn that itself calls a `wrap`ped chain) report the
 * full stage path via {@link StageHookEvent.path} — e.g. `['outer', 'inner']`
 * for the first stage of an inner chain running inside an outer one.
 *
 * The caller-provided `ctx` is forwarded to every stage fn and every
 * interceptor callback unchanged.
 */

/** A stage function: sync or async, payload-typed, ctx-threaded. */
export type StageFn<I, O, C> = (input: I, ctx: C) => O | Promise<O>

/** A named stage: the unit interceptors observe. */
export interface Stage<I = never, O = unknown, C = unknown> {
  readonly name: string
  readonly fn: StageFn<I, O, C>
}

/**
 * Define a named stage. `fn` may be sync or async — both are awaited by the
 * composed chain. The name is used in hook payloads and error attribution,
 * so keep it a short verb (`'parse'`, `'emit'`).
 */
export function defineStage<I, O, C = unknown>(name: string, fn: StageFn<I, O, C>): Stage<I, O, C> {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError(`defineStage(name, fn): name must be a non-empty string, got '${name}'`)
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`defineStage('${name}', fn): fn must be a function`)
  }
  return { name, fn }
}

/** Outcome of one stage invocation. */
export type StageOutcome = 'ok' | 'error'

/**
 * Payload handed to every interceptor callback — before, around and after.
 * Raw references, not copies: interceptors must treat input/output as
 * read-only unless deliberately replacing them via the return value.
 */
export interface StageHookEvent<I = unknown, C = unknown> {
  /** Name of the chain this stage belongs to (the `wrap(name, ...)` name). */
  readonly chain: string
  /** This stage's own name. */
  readonly stage: string
  /** This stage's index within its own chain. */
  readonly index: number
  /**
   * Full stage path: the chain names of all enclosing wrapped chains, outer
   * first, including this one. `['outer', 'inner']` means "stage of the
   * inner chain, invoked from a stage of the outer chain".
   */
  readonly path: readonly string[]
  /** The input this stage will see (after `before` replacement). */
  readonly input: I
  /** The caller-provided ctx, forwarded unchanged. */
  readonly ctx: C
}

/** Payload of an `after` interceptor on a successful stage invocation. */
export interface StageResultEvent<I = unknown, O = unknown, C = unknown>
  extends StageHookEvent<I, C> {
  readonly outcome: 'ok'
  readonly output: O
  /** ISO-8601 UTC timestamp when the stage started. */
  readonly startedAt: string
  /** Wall time of the stage fn (including `before` and `around` layers). */
  readonly durationMs: number
}

/**
 * Error thrown when a stage fails: attributes the failure to the stage that
 * threw (`stage`, `index`, `path`, `chain`) and keeps the original error as
 * `cause`. Later stages of the chain are skipped. `retryable` /
 * `retryAfterMs` duck-typed fields (see `RetryableError` in engine/retry)
 * are carried over from the cause so the step's retry policy still applies.
 */
export class StageError extends Error {
  readonly chain: string
  readonly stage: string
  readonly index: number
  readonly path: readonly string[]
  override readonly cause: unknown
  readonly retryable?: boolean
  readonly retryAfterMs?: number

  constructor(
    info: { chain: string; stage: string; index: number; path: readonly string[] },
    cause: unknown,
  ) {
    const causeMessage =
      cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : String(cause)
    super(`Stage '${[...info.path, info.stage].join('/')}' failed: ${causeMessage}`, { cause })
    this.name = 'StageError'
    this.chain = info.chain
    this.stage = info.stage
    this.index = info.index
    this.path = info.path
    this.cause = cause
    const retryable = readDuckField(cause, 'retryable')
    if (typeof retryable === 'boolean') this.retryable = retryable
    const retryAfterMs = readDuckField(cause, 'retryAfterMs')
    if (typeof retryAfterMs === 'number') this.retryAfterMs = retryAfterMs
  }
}

function readDuckField(cause: unknown, key: 'retryable' | 'retryAfterMs'): unknown {
  if (typeof cause !== 'object' || cause === null) return undefined
  return (cause as Record<string, unknown>)[key]
}

/**
 * A `before` interceptor: runs before the stage fn, in registration order.
 * Return a non-`undefined` value to replace the stage's input, or throw to
 * short-circuit the chain (the error propagates, later stages are skipped).
 */
export interface StageBeforeInterceptor {
  readonly kind: 'before'
  readonly fn: (event: StageHookEvent) => unknown | Promise<unknown>
}

/**
 * An `after` interceptor: runs after a SUCCESSFUL stage fn only — never when
 * the stage or an `around` interceptor failed. Receives the measured timing
 * payload ({@link StageResultEvent}). Return a non-`undefined` value to
 * replace the stage's output. Registrations stack, run in registration order.
 */
export interface StageAfterInterceptor {
  readonly kind: 'after'
  readonly fn: (event: StageResultEvent) => unknown | Promise<unknown>
}

/**
 * An `around` interceptor: middleware-style wrapper around one stage
 * invocation, exactly like koa / the pipeline's `.around()`. `next(input?)`
 * invokes the remaining around interceptors (onion-nested, first-registered
 * outermost) and finally the stage fn itself; the return value is the
 * (possibly replaced) stage output. Catching errors here replaces the
 * outcome — an around that swallows the error turns the stage into a success.
 */
export interface StageAroundInterceptor {
  readonly kind: 'around'
  readonly fn: (
    event: StageHookEvent,
    next: (input?: unknown) => Promise<unknown>,
  ) => Promise<unknown>
}

/** One registered stage interceptor; the chain dispatches per kind. */
export type StageInterceptor =
  | StageBeforeInterceptor
  | StageAfterInterceptor
  | StageAroundInterceptor

/** Next-link handed to `around` interceptors. */
export type StageNext = (input?: unknown) => Promise<unknown>

/**
 * A chain built by {@link wrap}: an async callable over the payload plus
 * interceptor registration. Calling it runs the stages sequentially and
 * resolves with the last stage's output. `ctx` is forwarded unchanged to
 * every stage fn and interceptor.
 */
export interface WrappedChain<I = unknown, O = unknown, C = unknown> {
  readonly name: string
  readonly stages: readonly Stage<never, unknown, C>[]
  (input: I, ctx: C): Promise<O>
  /** Register a stage interceptor. Registrations stack; returns the chain. */
  intercept(interceptor: StageInterceptor): WrappedChain<I, O, C>
}

/**
 * Full path of chain names for the currently executing wrapped chain.
 * AsyncLocalStorage so nested chains (invoked inside a stage fn) extend the
 * path without threading extra arguments through the stage signature.
 */
const chainPathStore = new AsyncLocalStorage<readonly string[]>()

/**
 * Compose stages into one sequential, interceptable chain. Stages are
 * structurally typed: `defineStage('a', (s: string) => ...)` fits any chain
 * because stage input is contravariant. Pin the payload types on the call:
 * `wrap<In, Out, Ctx>('name', ...stages)`.
 *
 * With no interceptors registered the call runs straight through the stage
 * fns — no timing, no event construction.
 *
 * @param name - Chain name; first segment of every {@link StageHookEvent.path}.
 * @param stages - At least one stage, run in order.
 */
export function wrap<I = unknown, O = unknown, C = unknown>(
  name: string,
  ...stages: Stage<never, unknown, C>[]
): WrappedChain<I, O, C> {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError(`wrap(name, ...stages): name must be a non-empty string, got '${name}'`)
  }
  if (stages.length === 0) {
    throw new TypeError(`wrap('${name}', ...stages): at least one stage is required`)
  }
  const interceptors: StageInterceptor[] = []

  const chain = async (input: I, ctx: C): Promise<O> => {
    const path = [...(chainPathStore.getStore() ?? []), name]
    const runStages = async (): Promise<O> => {
      let current: unknown = input
      for (const [index, stage] of stages.entries()) {
        current = await invokeStage(name, path, index, stage, interceptors, current, ctx)
      }
      return current as O
    }
    return chainPathStore.run(path, runStages)
  }

  const wrapped: WrappedChain<I, O, C> = Object.assign(chain, {
    stages,
    intercept(interceptor: StageInterceptor) {
      interceptors.push(interceptor)
      return wrapped
    },
  })
  // A function's own `name` is read-only but configurable — set the chain name.
  Object.defineProperty(wrapped, 'name', { value: name, configurable: true })
  return wrapped
}

/**
 * Run one stage through the interceptor chain: `before` replacements in
 * registration order, then the timed around-onion around the stage fn, then
 * `after` replacements. Throws {@link StageError} on failure (unless an
 * `around` layer handled it), skipping later stages.
 */
async function invokeStage<C>(
  chain: string,
  path: readonly string[],
  index: number,
  stage: Stage<never, unknown, C>,
  interceptors: readonly StageInterceptor[],
  input: unknown,
  ctx: C,
): Promise<unknown> {
  let current = input
  for (const interceptor of interceptors) {
    if (interceptor.kind !== 'before') continue
    const replaced = await interceptor.fn({
      chain,
      stage: stage.name,
      index,
      path,
      input: current,
      ctx,
    })
    if (replaced !== undefined && replaced !== null) current = replaced
  }

  const startedAt = new Date().toISOString()
  const start = performance.now()
  let output: unknown
  try {
    let next: StageNext = (value?: unknown) =>
      Promise.resolve(
        (stage.fn as StageFn<unknown, unknown, C>)(value === undefined ? current : value, ctx),
      )
    const arounds = interceptors.filter(
      (interceptor): interceptor is StageAroundInterceptor => interceptor.kind === 'around',
    )
    for (let aroundIndex = arounds.length - 1; aroundIndex >= 0; aroundIndex--) {
      const around = arounds[aroundIndex]
      if (!around) continue
      const inner = next
      next = (_value?: unknown) =>
        Promise.resolve(
          around.fn({ chain, stage: stage.name, index, path, input: current, ctx }, inner),
        )
    }
    output = await next()
  } catch (error) {
    // A StageError from a nested chain already carries its (deeper) path —
    // rethrow untouched; later stages of THIS chain are still skipped.
    if (error instanceof StageError) throw error
    throw new StageError({ chain, stage: stage.name, index, path }, error)
  }
  const durationMs = performance.now() - start

  let result = output
  for (const interceptor of interceptors) {
    if (interceptor.kind !== 'after') continue
    const replaced = await interceptor.fn({
      chain,
      stage: stage.name,
      index,
      path,
      input: current,
      ctx,
      outcome: 'ok',
      output: result,
      startedAt,
      durationMs,
    })
    if (replaced !== undefined && replaced !== null) result = replaced
  }
  return result
}
