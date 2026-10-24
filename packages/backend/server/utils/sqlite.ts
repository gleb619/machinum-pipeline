import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Minimal driver surface used by the backend; satisfied by better-sqlite3 and bun:sqlite. */
export interface Database {
  exec(sql: string): unknown
  prepare(sql: string): { run(...params: unknown[]): unknown }
  close(): void
}

const require = createRequire(import.meta.url)

let db: Database | null = null

export function getDb(): Database | null {
  return db
}

/**
 * Open the driver for the current runtime: `bun:sqlite` under Bun (built in, works inside the
 * single-file binary), `better-sqlite3` (native addon) under Node.
 */
function openDatabase(dbPath: string): Database {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    const { Database: BunDatabase } = require('bun:sqlite') as {
      Database: new (path: string) => Database
    }
    return new BunDatabase(dbPath)
  }
  const Sqlite = require('better-sqlite3') as new (path: string) => Database
  return new Sqlite(dbPath)
}

export function initSqlite(projectRoot: string): Database {
  mkdirSync(join(projectRoot, '.mt'), { recursive: true })
  const dbPath = join(projectRoot, '.mt', 'mt.sqlite')
  db = openDatabase(dbPath)

  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id          TEXT PRIMARY KEY,
      state       TEXT NOT NULL DEFAULT 'pending',
      pipeline_id TEXT NOT NULL,
      started_at  TEXT,
      updated_at  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS run_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      type      TEXT NOT NULL,
      data      TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id);
    CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
  `)

  return db
}

export function closeSqlite(): void {
  if (db) {
    db.close()
    db = null
  }
}
