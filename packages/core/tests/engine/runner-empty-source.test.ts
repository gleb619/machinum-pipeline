import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import type { Envelope, Pipeline, Tool } from '../../src/types.js'
import { registry } from '../../src/uri.js'

vi.mock('../../src/store.js', () => ({
  Store: class {
    ensureDir = vi.fn().mockResolvedValue(undefined)
    writeJson = vi.fn().mockResolvedValue(undefined)
    readJson = vi.fn().mockResolvedValue({ state: 'done', checkpoint: { stepId: 'root' } })
    append = vi.fn().mockResolvedValue(undefined)
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

// Mock source that yields nothing (empty)
const emptySourceItems: Array<Envelope<unknown>> = []

registry.registerSource('empty-source', (_uri) => ({
  uri: _uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of emptySourceItems) yield env
  },
  async *resume() {
    for (const env of emptySourceItems) yield env
  },
}))

registry.registerTarget('mock-target', (_uri) => ({
  uri: _uri.raw,
  async open() {},
  async write(_env: Envelope<unknown>) {},
  async close() {},
}))

const globalContext: GlobalContext = {
  project: { name: 'test', root: '/tmp/test-empty-source' },
  defaults: {
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' as const },
    onError: 'fail-run' as const,
    concurrency: 1,
  },
  settings: {},
  env: {},
}

const defaultRetry = { max: 0, backoffMs: 0, strategy: 'fixed' as const }

describe('runner empty source', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    emptySourceItems.length = 0
  })

  it('should not inject fake envelope when source yields nothing', async () => {
    const toolCalls: unknown[] = []
    const crashTool: Tool<unknown, unknown> = {
      name: 'crash-tool',
      version: '1.0.0',
      mdDescription: 'Test tool',
      exec: 'inproc',
      invoke: vi.fn(async (env: Envelope<unknown>) => {
        toolCalls.push(env.item)
        return env
      }),
    }

    const pipeline: Pipeline = {
      id: 'empty-source-pipeline',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'empty-source://input' } },
        { type: 'tool', config: { name: 'crash-tool', tool: crashTool } },
        { type: 'target', config: { uri: 'mock-target://output' } },
      ],
    }

    await new Runner(pipeline, globalContext).start()

    // Tool should NOT be called when source yields nothing
    expect(crashTool.invoke).not.toHaveBeenCalled()
    expect(toolCalls).toHaveLength(0)
  })

  it('should inject fake envelope for tool-only pipeline (no source step)', async () => {
    const toolCalls: unknown[] = []
    const toolOnlyTool: Tool<unknown, unknown> = {
      name: 'tool-only-tool',
      version: '1.0.0',
      mdDescription: 'Test tool',
      exec: 'inproc',
      invoke: vi.fn(async (env: Envelope<unknown>) => {
        toolCalls.push(env.item)
        return env
      }),
    }

    const pipeline: Pipeline = {
      id: 'tool-only-pipeline',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'tool', config: { name: 'tool-only-tool', tool: toolOnlyTool } },
        { type: 'target', config: { uri: 'mock-target://output' } },
      ],
    }

    await new Runner(pipeline, globalContext).start()

    // Tool should be called with fake envelope for tool-only pipeline
    expect(toolOnlyTool.invoke).toHaveBeenCalledTimes(1)
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toEqual({})
  })
})
