import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteMetricsStore } from '../src/metrics-store.js'
import type { MetricsEvent } from '../src/metrics.js'
import {
  BufferedMetricsRecorder,
  createMetricsRecorder,
  defaultMetricsDbPath,
  metricsEnabled,
} from '../src/metrics.js'
import type { Logger } from '../src/types.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mt-metrics-recorder-'))
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
    durationMs: 1,
    outcome: 'ok',
    ...overrides,
  }
}

function captureLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = []
  const logger: Logger = {
    info: () => {},
    warn: (message) => {
      warns.push(message)
    },
    error: () => {},
    debug: () => {},
  }
  return { logger, warns }
}

describe('createMetricsRecorder', () => {
  it('returns a recorder that persists events and a run summary on close', async () => {
    const dbPath = join(dir, 'metrics.db')
    const { logger } = captureLogger()
    const recorder = await createMetricsRecorder({
      runId: 'run-1',
      pipelineId: 'pipe',
      dbPath,
      logger,
      flushIntervalMs: 0,
    })
    expect(recorder).not.toBeNull()
    if (!recorder) return

    recorder.record(event())
    recorder.record(event({ exchangeId: 'ex-2', outcome: 'error', errorMessage: 'boom' }))
    await recorder.close()

    const store = SqliteMetricsStore.open(dbPath)
    expect(store.queryEvents({ runId: 'run-1' })).toHaveLength(2)
    const summary = store.getRunSummary('run-1')
    expect(summary?.okCount).toBe(1)
    expect(summary?.errorCount).toBe(1)
    store.close()
  })

  it('returns null and logs exactly one warn line when the DB cannot be opened', async () => {
    const { logger, warns } = captureLogger()
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'not a directory')
    // Path sits under a regular file → mkdir fails → open throws.
    const recorder = await createMetricsRecorder({
      runId: 'run-1',
      pipelineId: 'pipe',
      dbPath: join(blocker, 'metrics.db'),
      logger,
      flushIntervalMs: 0,
    })
    expect(recorder).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('Metrics disabled')
    expect(warns[0]).toContain(blocker)
  })

  it('flush failures never reject close', async () => {
    const { logger, warns } = captureLogger()
    const brokenStore = {
      dbPath: join(dir, 'metrics.db'),
      recordEvents: () => {
        throw new Error('disk gone')
      },
      upsertRunSummary: () => {
        throw new Error('disk gone')
      },
      close: () => {},
    }
    const recorder = new BufferedMetricsRecorder(
      {
        runId: 'run-1',
        pipelineId: 'pipe',
        dbPath: brokenStore.dbPath,
        logger,
        flushIntervalMs: 0,
      },
      brokenStore,
    )
    recorder.record(event())
    await expect(recorder.close()).resolves.toBeUndefined()
    expect(warns.length).toBeGreaterThanOrEqual(1)
  })
})

describe('metricsEnabled / defaultMetricsDbPath', () => {
  it('is enabled unless MT_METRICS=false', () => {
    expect(metricsEnabled({})).toBe(true)
    expect(metricsEnabled({ MT_METRICS: 'true' })).toBe(true)
    expect(metricsEnabled({ MT_METRICS: 'false' })).toBe(false)
  })

  it('defaults the DB path to <root>/.mt/metrics.db', () => {
    expect(defaultMetricsDbPath('/proj')).toBe(join('/proj', '.mt', 'metrics.db'))
  })
})
