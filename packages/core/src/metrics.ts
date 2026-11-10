import { join } from 'node:path'
import { SqliteMetricsStore } from './metrics-store.js'
import type { Logger } from './types.js'

/**
 * Outcome of one measured step invocation.
 */
export type MetricsOutcome = 'ok' | 'error'

/**
 * Kind of pipeline step a metric event belongs to. Only `'tool'` is measured
 * today; the union leaves room for source/target timing without a migration.
 */
export type MetricsStepType = 'tool'

/**
 * One metric event — a single measured step invocation. This is the
 * exporter-facing shape (Prometheus, OTel, ...): plain serializable data, no
 * SQL-isms, so an exporter can consume events without touching the store.
 */
export interface MetricsEvent {
  readonly runId: string
  readonly pipelineId: string
  readonly stepType: MetricsStepType
  /** Engine step id (e.g. `tool-echo-1`) — disambiguates repeated uses of one tool. */
  readonly stepName: string
  /** The tool's own name. */
  readonly toolName: string
  readonly exchangeId: string
  /** ISO-8601 UTC timestamp when the invocation started. */
  readonly startedAt: string
  readonly durationMs: number
  readonly outcome: MetricsOutcome
  readonly errorMessage?: string
}

/**
 * Run-level aggregate, written once when the run finishes.
 */
export interface MetricsRunSummary {
  readonly runId: string
  readonly pipelineId: string
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly okCount: number
  readonly errorCount: number
}

/**
 * Persistence backend for metric events. The SQLite implementation lives in
 * `metrics-store.ts`; exporters may implement it to forward events elsewhere.
 */
export interface MetricsStore {
  readonly dbPath: string
  recordEvents(events: readonly MetricsEvent[]): void
  upsertRunSummary(summary: MetricsRunSummary): void
  close(): void
}

/**
 * Per-run recorder. Created when a run starts, closed (flushed) when it ends.
 */
export interface MetricsRecorder {
  readonly runId: string
  record(event: MetricsEvent): void
  close(): Promise<void>
}

export interface CreateMetricsRecorderOptions {
  readonly runId: string
  readonly pipelineId: string
  readonly dbPath: string
  readonly logger: Logger
  /** Periodic flush interval; default 1000ms. `0` disables the timer (flush on close only). */
  readonly flushIntervalMs?: number
  /** Flush immediately when the pending buffer reaches this size; default 500. */
  readonly highWaterMark?: number
}

/**
 * Metrics are on unless explicitly disabled: `MT_METRICS=false`.
 * `process.env` wins over mt.json env (same precedence as the rest of the engine).
 */
export function metricsEnabled(env: { MT_METRICS?: string }): boolean {
  return env.MT_METRICS !== 'false'
}

/** Default location of the metrics DB: `<projectRoot>/.mt/metrics.db`. */
export function defaultMetricsDbPath(projectRoot: string): string {
  return join(projectRoot, '.mt', 'metrics.db')
}

/**
 * Open the SQLite store and create a buffered recorder for one run.
 *
 * Never throws: when the DB cannot be opened (missing/broken native addon, bad
 * path), exactly one WARN line is logged and `null` is returned — the caller
 * runs without metrics. This is the single funnel for "metrics must never
 * crash or block a run".
 */
export async function createMetricsRecorder(
  options: CreateMetricsRecorderOptions,
): Promise<MetricsRecorder | null> {
  let store: SqliteMetricsStore
  try {
    store = SqliteMetricsStore.open(options.dbPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.logger.warn(
      `Metrics disabled: failed to open metrics DB at ${options.dbPath}: ${message}`,
    )
    return null
  }
  return new BufferedMetricsRecorder(options, store)
}

/**
 * Buffered {@link MetricsRecorder}: events accumulate in memory and are written
 * in batches, because the driver is synchronous and a per-invocation write would
 * block the event loop on every tool call. Batches flush on a timer (default
 * 1s, unref'd so it never keeps the process alive), at a high-water mark, and
 * always on {@link close}. Flush yields once through `setImmediate` first, so
 * bursts of concurrent tool invocations collapse into fewer sync writes.
 * Flush/close failures are warn-logged and dropped — metrics never fail a run.
 */
export class BufferedMetricsRecorder implements MetricsRecorder {
  private buffer: MetricsEvent[] = []
  private okCount = 0
  private errorCount = 0
  private flushInFlight: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private warnLogged = false
  private readonly startedAt = new Date()
  private readonly highWaterMark: number

  constructor(
    private readonly options: CreateMetricsRecorderOptions,
    private readonly store: MetricsStore,
  ) {
    this.highWaterMark = options.highWaterMark ?? 500
    const interval = options.flushIntervalMs ?? 1000
    if (interval > 0) {
      this.timer = setInterval(() => {
        this.flush()
      }, interval)
      this.timer.unref()
    }
  }

  get runId(): string {
    return this.options.runId
  }

  record(event: MetricsEvent): void {
    if (this.closed) return
    this.buffer.push(event)
    if (event.outcome === 'ok') this.okCount++
    else this.errorCount++
    if (this.buffer.length >= this.highWaterMark) this.flush()
  }

  /**
   * Flush pending events and write the run summary. Idempotent; never throws.
   * The store is closed here — one recorder owns one run, and the DB is opened
   * per process anyway (subsequent runs reopen it).
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    try {
      await this.flushNow()
      const endedAt = new Date()
      this.store.upsertRunSummary({
        runId: this.options.runId,
        pipelineId: this.options.pipelineId,
        startedAt: this.startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - this.startedAt.getTime(),
        okCount: this.okCount,
        errorCount: this.errorCount,
      })
    } catch (error) {
      this.warnOnce(`Failed to flush metrics for run ${this.options.runId}: ${error}`)
    } finally {
      try {
        this.store.close()
      } catch {
        // A close failure is unrecoverable and irrelevant — the process is done.
      }
    }
  }

  /** Fire-and-forget flush (timer / high-water mark path). */
  private flush(): void {
    if (this.flushInFlight) return
    this.flushInFlight = this.flushNow().finally(() => {
      this.flushInFlight = null
    })
  }

  private async flushNow(): Promise<void> {
    // Yield once so concurrent invocations recorded after this flush started
    // are picked up in one batch instead of many tiny sync writes.
    await new Promise<void>((resolve) => setImmediate(resolve))
    const batch = this.buffer
    if (batch.length === 0) return
    this.buffer = []
    try {
      this.store.recordEvents(batch)
    } catch (error) {
      this.warnOnce(`Metrics write failed, dropping batch of ${batch.length}: ${error}`)
    }
  }

  private warnOnce(message: string): void {
    if (this.warnLogged) return
    this.warnLogged = true
    this.options.logger.warn(message)
  }
}
