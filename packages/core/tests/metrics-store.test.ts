import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteMetricsStore } from '../src/metrics-store.js'
import type { MetricsEvent } from '../src/metrics.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mt-metrics-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function event(overrides: Partial<MetricsEvent> = {}): MetricsEvent {
  return {
    runId: 'run-1',
    pipelineId: 'pipe',
    stepType: 'tool',
    stepName: 'tool-echo-1',
    toolName: 'echo',
    exchangeId: 'ex-1',
    startedAt: '2026-11-10T00:00:00.000Z',
    durationMs: 12.5,
    outcome: 'ok',
    ...overrides,
  }
}

describe('SqliteMetricsStore', () => {
  it('opens in WAL mode', () => {
    const store = SqliteMetricsStore.open(join(dir, 'metrics.db'))
    expect(store.journalMode()).toBe('wal')
    store.close()
  })

  it('persists events and reads them back', () => {
    const store = SqliteMetricsStore.open(join(dir, 'metrics.db'))
    store.recordEvents([
      event(),
      event({ exchangeId: 'ex-2', outcome: 'error', errorMessage: 'boom', toolName: 'failer' }),
    ])

    const all = store.queryEvents({ runId: 'run-1' })
    expect(all).toHaveLength(2)
    expect(all[0]).toMatchObject({ runId: 'run-1', toolName: 'echo', outcome: 'ok' })
    expect(all[1]).toMatchObject({
      exchangeId: 'ex-2',
      outcome: 'error',
      errorMessage: 'boom',
      toolName: 'failer',
    })
    expect(all[1]?.errorMessage).toBe('boom')
    store.close()
  })

  it('keeps data across reopen', () => {
    const path = join(dir, 'metrics.db')
    const store = SqliteMetricsStore.open(path)
    store.recordEvents([event()])
    store.close()

    const reopened = SqliteMetricsStore.open(path)
    expect(reopened.queryEvents({ runId: 'run-1' })).toHaveLength(1)
    reopened.close()
  })

  it('filters by runId, toolName and outcome', () => {
    const store = SqliteMetricsStore.open(join(dir, 'metrics.db'))
    store.recordEvents([
      event(),
      event({ runId: 'run-2', exchangeId: 'ex-2' }),
      event({ runId: 'run-2', exchangeId: 'ex-3', outcome: 'error', errorMessage: 'x' }),
    ])

    expect(store.queryEvents({ runId: 'run-2' })).toHaveLength(2)
    expect(store.queryEvents({ runId: 'run-2', outcome: 'error' })).toHaveLength(1)
    expect(store.queryEvents({ toolName: 'echo', limit: 1 })).toHaveLength(1)
    store.close()
  })

  it('upserts run summaries and reads them back', () => {
    const store = SqliteMetricsStore.open(join(dir, 'metrics.db'))
    store.upsertRunSummary({
      runId: 'run-1',
      pipelineId: 'pipe',
      startedAt: '2026-11-10T00:00:00.000Z',
      endedAt: '2026-11-10T00:01:00.000Z',
      durationMs: 60_000,
      okCount: 3,
      errorCount: 1,
    })
    // A second upsert for the same run replaces the summary.
    store.upsertRunSummary({
      runId: 'run-1',
      pipelineId: 'pipe',
      startedAt: '2026-11-10T00:00:00.000Z',
      endedAt: '2026-11-10T00:02:00.000Z',
      durationMs: 120_000,
      okCount: 5,
      errorCount: 2,
    })

    const summary = store.getRunSummary('run-1')
    expect(summary).not.toBeNull()
    expect(summary?.okCount).toBe(5)
    expect(summary?.errorCount).toBe(2)
    expect(summary?.durationMs).toBe(120_000)
    expect(store.getRunSummary('nope')).toBeNull()
    store.close()
  })

  it('throws for a broken DB path', async () => {
    // A regular file where the parent directory should be — mkdir inside open fails.
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'not a directory')
    expect(() => SqliteMetricsStore.open(join(blocker, 'metrics.db'))).toThrow()
  })
})
