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
  /** Explicit run id (worker children replay the id minted by the main backend). */
  runId?: string
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
