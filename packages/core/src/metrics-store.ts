import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type { MetricsEvent, MetricsRunSummary, MetricsStore } from './metrics.js'

/**
 * Minimal driver surface for the metrics DB; satisfied by `better-sqlite3` (Node)
 * and `bun:sqlite` (Bun / single-file binary). Keeping the interface local means
 * core does not need the addon's type package and a broken native addon is caught
 * at open time, never at import time.
 */
export interface MetricsDatabase {
  exec(sql: string): unknown
  prepare(sql: string): MetricsStatement
  close(): void
}

export interface MetricsStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown
}

/**
 * Row shape of the `metrics_events` table (columns mirror {@link MetricsEvent}).
 */
interface MetricsEventRow {
  run_id: string
  pipeline_id: string
  step_type: string
  step_name: string
  tool_name: string
  exchange_id: string
  started_at: string
  duration_ms: number
  outcome: string
  error_message: string | null
}

interface MetricsRunRow {
  run_id: string
  pipeline_id: string
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  ok_count: number
  error_count: number
}

/**
 * Filters for {@link SqliteMetricsStore.queryEvents}. All fields optional;
 * exporters (Prometheus, OTel, ...) read through this instead of raw SQL.
 */
export interface MetricsQuery {
  readonly runId?: string
  readonly toolName?: string
  readonly outcome?: 'ok' | 'error'
  readonly limit?: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metrics_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,
  pipeline_id   TEXT NOT NULL,
  step_type     TEXT NOT NULL,
  step_name     TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  exchange_id   TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  duration_ms   REAL NOT NULL,
  outcome       TEXT NOT NULL,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_metrics_events_run_id ON metrics_events (run_id);
CREATE INDEX IF NOT EXISTS idx_metrics_events_tool_name ON metrics_events (tool_name);
CREATE INDEX IF NOT EXISTS idx_metrics_events_started_at ON metrics_events (started_at);

CREATE TABLE IF NOT EXISTS metrics_runs (
  run_id      TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  duration_ms REAL,
  ok_count    INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0
);
`

/**
 * SQLite-backed {@link MetricsStore} for one metrics DB (`.mt/metrics.db` by default).
 * Opened in WAL mode with `synchronous=NORMAL` — metrics are an observation, not a
 * correctness mechanism, so durability is traded for write throughput.
 *
 * Writes arrive as whole batches from the recorder; each batch runs in one
 * transaction so a flush is a single fsync at most (WAL + NORMAL already defers it).
 */
export class SqliteMetricsStore implements MetricsStore {
  private readonly db: MetricsDatabase
  private readonly insertEvent: MetricsStatement
  private readonly insertRun: MetricsStatement

  private constructor(
    readonly dbPath: string,
    db: MetricsDatabase,
  ) {
    this.db = db
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(SCHEMA)
    this.insertEvent = db.prepare(
      `INSERT INTO metrics_events
         (run_id, pipeline_id, step_type, step_name, tool_name, exchange_id,
          started_at, duration_ms, outcome, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.insertRun = db.prepare(
      `INSERT INTO metrics_runs
         (run_id, pipeline_id, started_at, ended_at, duration_ms, ok_count, error_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         ended_at = excluded.ended_at,
         duration_ms = excluded.duration_ms,
         ok_count = excluded.ok_count,
         error_count = excluded.error_count`,
    )
  }

  /**
   * Open (and initialize, if needed) the metrics DB at `dbPath`. Throws when the
   * driver cannot be loaded or the file cannot be opened — callers are expected
   * to catch, warn once and continue the run without metrics.
   */
  static open(dbPath: string): SqliteMetricsStore {
    mkdirSync(dirname(dbPath), { recursive: true })
    return new SqliteMetricsStore(dbPath, openDriver(dbPath))
  }

  /** Effective `journal_mode` — `wal` on success. */
  journalMode(): string {
    const row = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string } | undefined
    return row?.journal_mode ?? 'unknown'
  }

  recordEvents(events: readonly MetricsEvent[]): void {
    if (events.length === 0) return
    this.db.exec('BEGIN')
    try {
      for (const event of events) {
        this.insertEvent.run(
          event.runId,
          event.pipelineId,
          event.stepType,
          event.stepName,
          event.toolName,
          event.exchangeId,
          event.startedAt,
          event.durationMs,
          event.outcome,
          event.errorMessage ?? null,
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  upsertRunSummary(summary: MetricsRunSummary): void {
    this.insertRun.run(
      summary.runId,
      summary.pipelineId,
      summary.startedAt,
      summary.endedAt,
      summary.durationMs,
      summary.okCount,
      summary.errorCount,
    )
  }

  /** Read back events, newest last. Exporter-facing read path. */
  queryEvents(query: MetricsQuery = {}): MetricsEvent[] {
    const where: string[] = []
    const params: unknown[] = []
    if (query.runId !== undefined) {
      where.push('run_id = ?')
      params.push(query.runId)
    }
    if (query.toolName !== undefined) {
      where.push('tool_name = ?')
      params.push(query.toolName)
    }
    if (query.outcome !== undefined) {
      where.push('outcome = ?')
      params.push(query.outcome)
    }
    const sql = [
      'SELECT run_id, pipeline_id, step_type, step_name, tool_name, exchange_id,',
      '       started_at, duration_ms, outcome, error_message',
      'FROM metrics_events',
      ...(where.length > 0 ? [`WHERE ${where.join(' AND ')}`] : []),
      'ORDER BY id',
      ...(query.limit !== undefined ? ['LIMIT ?'] : []),
    ].join(' ')
    if (query.limit !== undefined) params.push(query.limit)
    const rows = this.db.prepare(sql).all(...params) as MetricsEventRow[]
    return rows.map((row) => ({
      runId: row.run_id,
      pipelineId: row.pipeline_id,
      stepType: row.step_type as MetricsEvent['stepType'],
      stepName: row.step_name,
      toolName: row.tool_name,
      exchangeId: row.exchange_id,
      startedAt: row.started_at,
      durationMs: row.duration_ms,
      outcome: row.outcome as MetricsEvent['outcome'],
      ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
    }))
  }

  getRunSummary(runId: string): MetricsRunSummary | null {
    const row = this.db.prepare('SELECT * FROM metrics_runs WHERE run_id = ?').get(runId) as
      | MetricsRunRow
      | undefined
    if (!row) return null
    return {
      runId: row.run_id,
      pipelineId: row.pipeline_id,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? '',
      durationMs: row.duration_ms ?? 0,
      okCount: row.ok_count,
      errorCount: row.error_count,
    }
  }

  close(): void {
    this.db.close()
  }
}

/**
 * Open the driver for the current runtime: `bun:sqlite` under Bun (built in, works
 * inside the single-file binary), `better-sqlite3` (native addon) under Node.
 *
 * The `better-sqlite3` specifier is kept in a variable on purpose: a literal
 * `require()` is statically analysed by bundlers, which pulls the native addon into
 * the single-file binary (where it cannot be loaded). A dynamic specifier keeps the
 * addon out of the bundle and lets a consumer project's own copy resolve at runtime.
 * A missing/broken addon surfaces here as a thrown require error — handled by the
 * recorder factory, never fatal to a run.
 */
function openDriver(dbPath: string): MetricsDatabase {
  const require = createRequire(import.meta.url)
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    const { Database: BunDatabase } = require('bun:sqlite') as {
      Database: new (path: string) => MetricsDatabase
    }
    return new BunDatabase(dbPath)
  }
  const sqliteAddon = 'better-sqlite3'
  const Sqlite = require(sqliteAddon) as new (path: string) => MetricsDatabase
  return new Sqlite(dbPath)
}
