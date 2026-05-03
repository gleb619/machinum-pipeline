import { createRequire } from 'node:module'
import { join } from 'node:path'

type Database = import('better-sqlite3').Database

const require = createRequire(import.meta.url)

let db: Database | null = null

export function getDb(): Database | null {
  return db
}

export function initSqlite(projectRoot: string): Database {
  const Sqlite = require('better-sqlite3') as new (path: string) => Database
  const dbPath = join(projectRoot, '.mt', 'mt.sqlite')
  db = new Sqlite(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

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
