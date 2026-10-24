import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalContext, RetryPolicy } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import type { Envelope, Pipeline, PipelineStep, Tool } from '../../src/types.js'
import { registry } from '../../src/uri.js'

vi.mock('../../src/store.js', () => ({
  Store: class {
    ensureDir = vi.fn().mockResolvedValue(undefined)
    writeJson = vi.fn().mockResolvedValue(undefined)
    readJson = vi.fn().mockResolvedValue({ state: 'done', checkpoint: { stepId: 'root' } })
    append = vi.fn().mockImplementation(async (line: string) => {
      appendedLines.push(line)
    })
  },
}))

vi.mock('../../src/engine/cache.js', () => ({
  Cache: class {
    computeKey = vi.fn().mockReturnValue('key')
    has = vi.fn().mockResolvedValue(false)
    get = vi.fn().mockResolvedValue(undefined)
    set = vi.fn().mockResolvedValue(undefined)
  },
}))

/** Every line appended to the mocked store (dead-letter queue). */
const appendedLines = vi.hoisted(() => [] as string[])

const sourceItems: Envelope<unknown>[] = []
const written: Envelope<unknown>[] = []

registry.registerSource('retry-source', (_uri) => ({
  uri: _uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of sourceItems) yield env
  },
  async *resume() {
    for (const env of sourceItems) yield env
  },
}))

registry.registerTarget('retry-target', (_uri) => ({
  uri: _uri.raw,
  async open() {
    written.length = 0
  },
  async write(env: Envelope<unknown>) {
    written.push(env)
  },
  async close() {},
}))

const defaultsContext = (retry: RetryPolicy): GlobalContext => ({
  project: { name: 'test', root: '/tmp/test-retry' },
  defaults: { retry, onError: 'fail-run' as const, concurrency: 1 },
  settings: {},
  env: {},
})

/** Tool whose `invoke` fails `failTimes` in a row (or always), then returns the envelope. */
function flakyTool(failTimes: number): { tool: Tool<unknown, unknown>; calls: () => number } {
  let attempts = 0
  const tool: Tool<unknown, unknown> = {
    name: 'flaky-tool',
    version: '1.0.0',
    mdDescription: 'Test tool flaky-tool that fails a configurable number of times.',
    invoke: async (env: Envelope<unknown>) => {
      attempts++
      if (failTimes === Number.POSITIVE_INFINITY || attempts <= failTimes) {
        throw new Error(`boom ${attempts}`)
      }
      return env
    },
  }
  return { tool, calls: () => attempts }
}

/** Tool that always throws an error declaring itself non-retryable (e.g. 402 quota). */
function fatalTool(): { tool: Tool<unknown, unknown>; calls: () => number } {
  let attempts = 0
  const tool: Tool<unknown, unknown> = {
    name: 'fatal-tool',
    version: '1.0.0',
    mdDescription: 'Test tool fatal-tool that fails the same way on every attempt.',
    invoke: async (_env: Envelope<unknown>) => {
      attempts++
      throw Object.assign(new Error('insufficient credits'), { retryable: false, status: 402 })
    },
  }
  return { tool, calls: () => attempts }
}

function pipelineWith(
  pipelineRetry: RetryPolicy | undefined,
  stepRetry: RetryPolicy | Partial<RetryPolicy> | undefined,
  tool: Tool<unknown, unknown>,
  onError: 'fail-run' | 'skip-item' | 'dead-letter' = 'fail-run',
): Pipeline {
  const steps: PipelineStep[] = [
    { type: 'source', config: { uri: 'retry-source://input' } },
    { type: 'tool', config: { name: tool.name, tool, retry: stepRetry } },
    { type: 'target', config: { uri: 'retry-target://output' } },
  ]

  return {
    id: 'retry-override-pipeline',
    retry: pipelineRetry as RetryPolicy,
    onError,
    steps,
  }
}

describe('Runner retry policy merge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sourceItems.length = 0
    written.length = 0
    appendedLines.length = 0
    sourceItems.push({ item: 'a', meta: {} })
  })

  it('a partial step override keeps the pipeline max (tool is still invoked)', async () => {
    const { tool, calls } = flakyTool(2)
    const pipeline = pipelineWith(
      { max: 3, backoffMs: 999, strategy: 'fixed' },
      { backoffMs: 1 },
      tool,
    )

    await new Runner(pipeline, defaultsContext({ max: 0, backoffMs: 0, strategy: 'fixed' })).start()

    // max comes from the pipeline, backoffMs from the override: 3 failures would exhaust,
    // so a merged max of 3 must succeed on the 3rd attempt.
    expect(calls()).toBe(3)
    expect(written).toHaveLength(1)
  })

  it('a partial `{ max }` override inherits the outer backoffMs and strategy', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const { tool, calls } = flakyTool(2)
    const pipeline = pipelineWith({ max: 0, backoffMs: 40, strategy: 'linear' }, { max: 2 }, tool)

    await new Runner(pipeline, defaultsContext({ max: 0, backoffMs: 0, strategy: 'fixed' })).start()

    expect(calls()).toBe(3)
    const delays = spy.mock.calls.map((args) => args[1])
    expect(delays).toContain(40)
    expect(delays).toContain(80)
    expect(delays.some((d) => !Number.isFinite(d))).toBe(false)
    spy.mockRestore()
  })

  it('falls through to globalContext defaults when the pipeline declares no retry', async () => {
    const { tool, calls } = flakyTool(1)
    const pipeline = pipelineWith(undefined, { backoffMs: 1 }, tool)

    await new Runner(pipeline, defaultsContext({ max: 2, backoffMs: 5, strategy: 'fixed' })).start()

    expect(calls()).toBe(2)
  })

  it('a full step override replaces every outer layer field', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const { tool, calls } = flakyTool(1)
    const pipeline = pipelineWith(
      { max: 5, backoffMs: 999, strategy: 'exp' },
      { max: 1, backoffMs: 5, strategy: 'fixed' },
      tool,
    )

    await new Runner(pipeline, defaultsContext({ max: 0, backoffMs: 0, strategy: 'fixed' })).start()

    expect(calls()).toBe(2)
    expect(spy.mock.calls.map((args) => args[1])).toContain(5)
    spy.mockRestore()
  })

  it('exhausted retries fail the run with the last tool error, not undefined', async () => {
    const { tool, calls } = flakyTool(Number.POSITIVE_INFINITY)
    const pipeline = pipelineWith(
      { max: 2, backoffMs: 1, strategy: 'fixed' },
      { backoffMs: 1 },
      tool,
    )

    await expect(
      new Runner(pipeline, defaultsContext({ max: 0, backoffMs: 0, strategy: 'fixed' })).start(),
    ).rejects.toThrow('boom 3')
    expect(calls()).toBe(3)
  })

  it('rejects an invalid retry override with a clear error instead of silently skipping the tool', async () => {
    const invalidCases: Array<Partial<RetryPolicy>> = [
      { max: -1 },
      { max: 1.5 },
      { backoffMs: -5 },
      { backoffMs: Number.NaN },
    ]

    for (const retry of invalidCases) {
      const neverCalled = flakyTool(0)
      const pipeline = pipelineWith(
        { max: 2, backoffMs: 1, strategy: 'fixed' },
        retry,
        neverCalled.tool,
      )

      await expect(
        new Runner(pipeline, defaultsContext({ max: 0, backoffMs: 0, strategy: 'fixed' })).start(),
      ).rejects.toThrow(/[Rr]etry/)
      expect(neverCalled.calls()).toBe(0)
    }
  })

  it('fails the run on the first attempt when the tool error says retryable: false', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const { tool, calls } = fatalTool()
    // Expensive policy on purpose: a fatal error must not wait 1s + 2s + 4s before surfacing.
    const pipeline = pipelineWith({ max: 3, backoffMs: 1000, strategy: 'exp' }, undefined, tool)

    await expect(
      new Runner(pipeline, defaultsContext({ max: 0, backoffMs: 0, strategy: 'fixed' })).start(),
    ).rejects.toThrow('insufficient credits')

    expect(calls()).toBe(1)
    expect(spy.mock.calls.map((args) => args[1]).filter((d) => (d ?? 0) > 0)).toEqual([])
    spy.mockRestore()
  })

  it('routes a non-retryable tool error to dead-letter and still completes the run', async () => {
    const { tool, calls } = fatalTool()
    const pipeline = pipelineWith(
      { max: 3, backoffMs: 1, strategy: 'fixed' },
      undefined,
      tool,
      'dead-letter',
    )

    await new Runner(pipeline, defaultsContext({ max: 0, backoffMs: 0, strategy: 'fixed' })).start()

    expect(calls()).toBe(1)
    expect(written).toHaveLength(0)
    const entry = appendedLines
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { error?: { message?: string } })
      .find((json) => json.error?.message)
    expect(entry?.error?.message).toBe('insufficient credits')
  })
})
