import type { LogLevel, ToolFn } from '../dsl.js'
import type { ProcessMode } from '../process.js'
import type { SourceContext, TargetContext } from './contexts.js'
import type { Exchange } from './exchange.js'
import type { Tool } from './pipeline.js'
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
 * Options for `defineProcess(pipelines, options?)`.
 */
export interface ProcessOptions {
  /** Process id used in CLI logs. Default `'process'`. */
  id?: string
  /** Run mode. Default `'sync'`; prefer `.parallel(true)` over this. */
  mode?: ProcessMode
}

/**
 * Process-level configuration for a pipeline module. `env` entries are defaults:
 * the Runner applies them to the run env only for keys not already set in
 * `process.env` or the mt.json env, so real environment variables always win.
 */
export interface ProcessConfig {
  env?: Record<string, string>
}

/** Options of `.log()`. */
export interface LogOptions {
  /** Prefix for each line. Defaults to the pipeline id. */
  label?: string
  /** Severity to emit. Default `'log'` (maps to `info`); `'info'`/`'warn'`/`'error'`/`'debug'` map to themselves. */
  level?: LogLevel
  /** If `true`, truncate long text to `LOG_TEXT_MAX_LENGTH` chars (start + "..." + end + length). String items only. */
  truncate?: boolean
}

/** Options of `.batch()`. */
export interface BatchOptions {
  /** Positive integer package size. Default {@link DEFAULT_BATCH_SIZE}. */
  size?: number
  /** Sliding windows (one overlapping package per arrival) instead of tumbling. Default `false`. */
  slide?: boolean
}
