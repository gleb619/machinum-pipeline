import type { Exchange } from './exchange.js'
import type { BufferWriter, Pipeline } from './types/pipeline.js'
import type { RunEvent } from './types/run-events.js'

export * from './types/annotation.js'
export * from './types/atomic.js'
export * from './types/config.js'
export * from './types/contexts.js'
export * from './types/discovery.js'
export * from './types/domain-tree.js'
export * from './types/domain.js'
export * from './types/dsl.js'
export * from './types/engine/cache.js'
export * from './types/engine/dead-letter.js'
export * from './types/engine/git.js'
export * from './types/engine/git-worktree.js'
export * from './types/engine/retry.js'
export * from './types/exchange.js'
export * from './types/http-listener.js'
export * from './types/json-file.js'
export * from './types/logging.js'
export * from './types/pipeline.js'
export * from './types/process.js'
export * from './types/run-events.js'
export * from './types/secrets.js'
export * from './types/settings.js'
export * from './types/sync/apply.js'
export * from './types/sync/diff.js'
export * from './types/sync/manifest.js'
export * from './types/sync/scope.js'
export * from './types/text-split.js'
export * from './types/uri.js'
export * from './types/vault.js'

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

/** Factory for a namespace-scoped {@link BufferWriter}. */
export type BufferWriterFactory = (namespace: string) => BufferWriter

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
 * Event kinds appended to `.mt/runs/<runId>/events.jsonl` (the SSE source, UC015/UC029).
 */
export type RunEventType = 'started' | 'step-done' | 'paused' | 'resumed' | 'done' | 'failed'

/**
 * Listener for run lifecycle events (in-process counterpart of the events.jsonl log).
 * May return a promise — the Runner never awaits it; rejections are logged, never thrown.
 */
export type RunEventListener = (event: RunEvent) => void | Promise<void>
