import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Runner } from '../../src/engine/runner.js'
import { SqliteMetricsStore } from '../../src/metrics-store.js'
import type { Envelope, GlobalContext, Pipeline, Tool } from '../../src/types.js'
import { registry } from '../../src/uri.js'

const sourceItems: Array<Envelope<unknown>> = []

registry.registerSource('metrics-source', (_uri) => ({
  uri: _uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of sourceItems) yield env
  },
  async *resume() {
    for (const env of sourceItems) yield env
  },
}))

registry.registerTarget('metrics-target', (_uri) => ({
  uri: _uri.raw,
  async open() {},
  async write(_env: Envelope<unknown>) {},
  async close() {},
}))

const defaultRetry = { max: 0, backoffMs: 0, strategy: 'fixed' as const }

const echoTool: Tool<unknown, unknown> = {
  name: 'echo',
  version: '1.0.0',
  description: 'Passes the envelope through unchanged.',
  invoke: async (env) => env,
}

const explodeTool: Tool<unknown, unknown> = {
  name: 'exploder',
  version: '1.0.0',
  description: 'Always throws.',
  invoke: async () => {
    throw new Error('exploder exploded')
  },
}

let projectRoot: string
let metricsDb: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'mt-runner-metrics-'))
  metricsDb = join(projectRoot, '.mt', 'metrics.db')
  sourceItems.length = 0
  sourceItems.push({ id: 'ex-1', item: 'a', meta: {}, variables: [] })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(projectRoot, { recursive: true, force: true })
})

function context(): GlobalContext {
  return {
    project: { name: 'metrics-test', root: projectRoot },
    defaults: {
      retry: defaultRetry,
      onError: 'fail-run' as const,
      concurrency: 1,
    },
    settings: {},
    env: {},
  }
}

function pipeline(
  id: string,
  tool: Tool<unknown, unknown>,
  onError: 'fail-run' | 'skip-item',
): Pipeline {
  return {
    id,
    retry: defaultRetry,
    onError,
    steps: [
      { type: 'source', config: { uri: 'metrics-source://in' } },
      { type: 'tool', config: { name: tool.name, tool } },
      { type: 'target', config: { uri: 'metrics-target://out' } },
    ],
  }
}

describe('Runner metrics', () => {
  it('records ok tool invocations with a run summary', async () => {
    const runner = new Runner(pipeline('ok-pipe', echoTool, 'fail-run'), context())
    await runner.start()

    const store = SqliteMetricsStore.open(metricsDb)
    const events = store.queryEvents({ runId: runner.getRunId() ?? '' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      pipelineId: 'ok-pipe',
      stepType: 'tool',
      toolName: 'echo',
      exchangeId: 'ex-1',
      outcome: 'ok',
    })
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0)

    const summary = store.getRunSummary(runner.getRunId() ?? '')
    expect(summary?.okCount).toBe(1)
    expect(summary?.errorCount).toBe(0)
    store.close()
  })

  it('records error outcome with the error message when the tool fails', async () => {
    const runner = new Runner(pipeline('err-pipe', explodeTool, 'skip-item'), context())
    await runner.start()

    const store = SqliteMetricsStore.open(metricsDb)
    const events = store.queryEvents({ runId: runner.getRunId() ?? '' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      toolName: 'exploder',
      outcome: 'error',
      errorMessage: 'exploder exploded',
    })
    const summary = store.getRunSummary(runner.getRunId() ?? '')
    expect(summary?.errorCount).toBe(1)
    store.close()
  })

  it('writes nothing when MT_METRICS=false', async () => {
    vi.stubEnv('MT_METRICS', 'false')
    const runner = new Runner(pipeline('off-pipe', echoTool, 'fail-run'), context())
    await runner.start()

    await expect(access(metricsDb)).rejects.toThrow()
  })

  it('honours MT_METRICS_DB for the DB location', async () => {
    const custom = join(projectRoot, 'custom-metrics.db')
    vi.stubEnv('MT_METRICS_DB', custom)
    const runner = new Runner(pipeline('custom-pipe', echoTool, 'fail-run'), context())
    await runner.start()

    const store = SqliteMetricsStore.open(custom)
    expect(store.queryEvents({ runId: runner.getRunId() ?? '' })).toHaveLength(1)
    store.close()
  })
})
