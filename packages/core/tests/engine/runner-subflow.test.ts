import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import type { Envelope, Pipeline } from '../../src/types.js'
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

// --- Ephemeral scheme (in-memory buffer, keyed by host name) ---
const ephemeralBuffers = new Map<string, Array<Envelope<unknown>>>()

registry.registerSource('ephemeral', (uri) => {
  const name = uri.path || uri.host
  return {
    uri: uri.raw,
    lifestyle: 'resumable' as const,
    async *start() {
      const items = ephemeralBuffers.get(name) ?? []
      for (const env of items) yield env
    },
    async *resume() {
      const items = ephemeralBuffers.get(name) ?? []
      for (const env of items) yield env
    },
  }
})

registry.registerTarget('ephemeral', (uri) => {
  const name = uri.path || uri.host
  return {
    uri: uri.raw,
    async open() {
      ephemeralBuffers.set(name, [])
    },
    async write(env: Envelope<unknown>) {
      const arr = ephemeralBuffers.get(name) ?? []
      arr.push(env)
      ephemeralBuffers.set(name, arr)
    },
    async close() {},
  }
})

// --- Mock source/target schemes for main pipeline I/O ---
const mockSourceItems: Array<Envelope<unknown>> = []
const mockTargetItems: Array<Envelope<unknown>> = []

registry.registerSource('mock-source', (_uri) => ({
  uri: _uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of mockSourceItems) yield env
  },
  async *resume() {
    for (const env of mockSourceItems) yield env
  },
}))

registry.registerTarget('mock-target', (_uri) => ({
  uri: _uri.raw,
  async open() {
    mockTargetItems.length = 0
  },
  async write(env: Envelope<unknown>) {
    mockTargetItems.push(env)
  },
  async close() {},
}))

// --- Orchestration scheme (independent source/target for orch test) ---
const orchSourceItems: Array<Envelope<unknown>> = []
let orchToolCallCount = 0

registry.registerSource('orch-source', (_uri) => ({
  uri: _uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of orchSourceItems) yield env
  },
  async *resume() {
    for (const env of orchSourceItems) yield env
  },
}))

registry.registerTarget('orch-target', (_uri) => ({
  uri: _uri.raw,
  async open() {},
  async write(_env: Envelope<unknown>) {},
  async close() {},
}))

const globalContext: GlobalContext = {
  project: { name: 'test', root: '/tmp/test-subflow' },
  defaults: {
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' as const },
    onError: 'fail-run' as const,
    concurrency: 1,
  },
  env: {},
}

const defaultRetry = { max: 0, backoffMs: 0, strategy: 'fixed' as const }

describe('runner subflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ephemeralBuffers.clear()
    mockSourceItems.length = 0
    mockTargetItems.length = 0
    orchSourceItems.length = 0
    orchToolCallCount = 0
  })

  it('ephemeral transform mode: feeds each parent envelope through sub-pipeline', async () => {
    mockSourceItems.push({ item: { value: 1 }, meta: {} })
    mockSourceItems.push({ item: { value: 2 }, meta: {} })

    const processTool = {
      name: 'process-tool',
      version: '1.0.0',
      exec: 'inproc' as const,
      invoke: vi.fn(async (env: Envelope<unknown>) => ({
        ...env,
        meta: { ...env.meta, processed: true },
      })),
    }

    const subPipeline: Pipeline = {
      id: 'sub-pipeline',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'ephemeral://sub-in' } },
        { type: 'tool', config: { name: 'process-tool', tool: processTool } },
        { type: 'target', config: { uri: 'ephemeral://sub-out' } },
      ],
    }

    const mainPipeline: Pipeline = {
      id: 'main-pipeline',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'mock-source://input' } },
        { type: 'subflow', config: { name: 'sub', pipeline: subPipeline } },
        { type: 'target', config: { uri: 'mock-target://output' } },
      ],
    }

    await new Runner(mainPipeline, globalContext).start()

    expect(processTool.invoke).toHaveBeenCalledTimes(2)
    expect(mockTargetItems).toHaveLength(2)
    expect(mockTargetItems[0]?.meta.processed).toBe(true)
    expect(mockTargetItems[1]?.meta.processed).toBe(true)
  })

  it('ephemeral transform mode: preserves envelope item data through sub-pipeline', async () => {
    mockSourceItems.push({ item: { id: 'chapter-1', text: 'hello' }, meta: { chapterId: 'c1' } })

    const passThroughTool = {
      name: 'pass-through',
      version: '1.0.0',
      exec: 'inproc' as const,
      invoke: async (env: Envelope<unknown>) => ({ ...env, meta: { ...env.meta, passed: true } }),
    }

    const subPipeline: Pipeline = {
      id: 'pass-sub',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'ephemeral://pass-in' } },
        { type: 'tool', config: { name: 'pass-through', tool: passThroughTool } },
        { type: 'target', config: { uri: 'ephemeral://pass-out' } },
      ],
    }

    const mainPipeline: Pipeline = {
      id: 'pass-main',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'mock-source://input' } },
        { type: 'subflow', config: { name: 'pass-sub', pipeline: subPipeline } },
        { type: 'target', config: { uri: 'mock-target://output' } },
      ],
    }

    await new Runner(mainPipeline, globalContext).start()

    expect(mockTargetItems).toHaveLength(1)
    const result = mockTargetItems[0]
    expect(result?.meta.chapterId).toBe('c1')
    expect(result?.meta.passed).toBe(true)
  })

  it('orchestration mode: runs sub-pipeline independently when source is non-ephemeral', async () => {
    orchSourceItems.push({ item: { data: 'orch-item' }, meta: {} })

    const orchTool = {
      name: 'orch-tool',
      version: '1.0.0',
      exec: 'inproc' as const,
      invoke: vi.fn(async (env: Envelope<unknown>) => {
        orchToolCallCount++
        return env
      }),
    }

    const orchSubPipeline: Pipeline = {
      id: 'orch-sub',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'orch-source://data' } },
        { type: 'tool', config: { name: 'orch-tool', tool: orchTool } },
        { type: 'target', config: { uri: 'orch-target://out' } },
      ],
    }

    // Parent has no own source — pure orchestration
    const parentPipeline: Pipeline = {
      id: 'orch-parent',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [{ type: 'subflow', config: { name: 'orch', pipeline: orchSubPipeline } }],
    }

    await new Runner(parentPipeline, globalContext).start()

    expect(orchTool.invoke).toHaveBeenCalledTimes(1)
    expect(orchToolCallCount).toBe(1)
  })
})
