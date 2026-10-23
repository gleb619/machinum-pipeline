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

// --- Independent source/target for a self-contained subflow ---
const orchSourceItems: Array<Envelope<unknown>> = []

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
  settings: {},
  env: {},
}

const defaultRetry = { max: 0, backoffMs: 0, strategy: 'fixed' as const }

const processTool: Tool<unknown, unknown> = {
  name: 'process-tool',
  version: '1.0.0',
  exec: 'inproc',
  invoke: vi.fn(async (env: Envelope<unknown>) => ({
    ...env,
    meta: { ...env.meta, processed: true },
  })),
}

describe('runner subflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSourceItems.length = 0
    mockTargetItems.length = 0
    orchSourceItems.length = 0
  })

  it('inline mode: splices a steps-only subflow into the parent stream', async () => {
    mockSourceItems.push({ item: { value: 1 }, meta: {} })
    mockSourceItems.push({ item: { value: 2 }, meta: {} })

    const subPipeline: Pipeline = {
      id: 'sub-pipeline',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [{ type: 'tool', config: { name: 'process-tool', tool: processTool } }],
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

  it('inline mode: preserves envelope item data through the subflow', async () => {
    mockSourceItems.push({ item: { id: 'chapter-1', text: 'hello' }, meta: { chapterId: 'c1' } })

    const subPipeline: Pipeline = {
      id: 'pass-sub',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [{ type: 'tool', config: { name: 'process-tool', tool: processTool } }],
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
    expect(result?.item).toEqual({ id: 'chapter-1', text: 'hello' })
    expect(result?.meta.chapterId).toBe('c1')
    expect(result?.meta.processed).toBe(true)
  })

  it('inline mode: runs after upstream is consumed, not while the stream is built', async () => {
    mockSourceItems.push({ item: { value: 1 }, meta: {} })

    const order: string[] = []
    const recordingTool: Tool<unknown, unknown> = {
      name: 'recording-tool',
      version: '1.0.0',
      exec: 'inproc',
      invoke: async (env) => {
        order.push('subflow')
        return env
      },
    }
    const mark = (label: string) => async () => {
      order.push(label)
    }

    const subPipeline: Pipeline = {
      id: 'ordered-sub',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [{ type: 'tool', config: { name: 'recording-tool', tool: recordingTool } }],
    }

    const mainPipeline: Pipeline = {
      id: 'ordered-main',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'mock-source://input' } },
        { type: 'tap', config: { fn: mark('upstream') } },
        { type: 'subflow', config: { name: 'ordered-sub', pipeline: subPipeline } },
        { type: 'tap', config: { fn: mark('downstream') } },
        { type: 'target', config: { uri: 'mock-target://output' } },
      ],
    }

    await new Runner(mainPipeline, globalContext).start()

    expect(order).toEqual(['upstream', 'subflow', 'downstream'])
    expect(mockTargetItems).toHaveLength(1)
  })

  it('inline mode: supports batch/flatMap/tap steps in the subflow', async () => {
    mockSourceItems.push({ item: 1, meta: {} })
    mockSourceItems.push({ item: 2, meta: {} })
    mockSourceItems.push({ item: 3, meta: {} })

    const tapped: unknown[] = []
    const subPipeline: Pipeline = {
      id: 'batchy-sub',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'batch', config: { size: 2 } },
        { type: 'tap', config: { fn: async (group: unknown) => void tapped.push(group) } },
        { type: 'flatmap', config: { fn: async (group: unknown) => group as unknown[] } },
      ],
    }

    const mainPipeline: Pipeline = {
      id: 'batchy-main',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'mock-source://input' } },
        { type: 'subflow', config: { name: 'batchy-sub', pipeline: subPipeline } },
        { type: 'target', config: { uri: 'mock-target://output' } },
      ],
    }

    await new Runner(mainPipeline, globalContext).start()

    // 3 items → groups [1,2] and [3] → flatMap fans both back out
    expect(tapped).toEqual([[1, 2], [3]])
    expect(mockTargetItems.map((env) => env.item)).toEqual([1, 2, 3])
  })

  it('self-contained mode: subflow with its own source runs independently of the parent stream', async () => {
    mockSourceItems.push({ item: { value: 1 }, meta: {} })
    mockSourceItems.push({ item: { value: 2 }, meta: {} })
    orchSourceItems.push({ item: { data: 'orch-item' }, meta: {} })

    const orchTool: Tool<unknown, unknown> = {
      name: 'orch-tool',
      version: '1.0.0',
      exec: 'inproc',
      invoke: vi.fn(async (env) => env),
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

    const parentPipeline: Pipeline = {
      id: 'orch-parent',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'mock-source://input' } },
        { type: 'subflow', config: { name: 'orch', pipeline: orchSubPipeline } },
        { type: 'target', config: { uri: 'mock-target://output' } },
      ],
    }

    await new Runner(parentPipeline, globalContext).start()

    expect(orchTool.invoke).toHaveBeenCalledTimes(1)
    expect(orchTool.invoke).toHaveBeenCalledWith(
      { item: { data: 'orch-item' }, meta: {} },
      expect.anything(),
    )
    // Parent stream is untouched by the self-contained subflow
    expect(mockTargetItems.map((env) => env.item)).toEqual([{ value: 1 }, { value: 2 }])
  })

  it('orchestration mode: parent with no source/target still runs its subflows', async () => {
    orchSourceItems.push({ item: { data: 'orch-item' }, meta: {} })

    const orchTool: Tool<unknown, unknown> = {
      name: 'orch-tool',
      version: '1.0.0',
      exec: 'inproc',
      invoke: vi.fn(async (env) => env),
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

    const parentPipeline: Pipeline = {
      id: 'orch-parent',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [{ type: 'subflow', config: { name: 'orch', pipeline: orchSubPipeline } }],
    }

    await new Runner(parentPipeline, globalContext).start()

    expect(orchTool.invoke).toHaveBeenCalledTimes(1)
  })

  it('runs self-contained subflows in pipeline order', async () => {
    orchSourceItems.push({ item: { data: 'orch-item' }, meta: {} })
    const order: string[] = []
    const makeSub = (id: string, label: string): Pipeline => ({
      id,
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'orch-source://data' } },
        {
          type: 'tap',
          config: {
            fn: async () => {
              order.push(label)
            },
          },
        },
        { type: 'target', config: { uri: 'orch-target://out' } },
      ],
    })

    const parentPipeline: Pipeline = {
      id: 'ordered-parent',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'subflow', config: { name: 'first', pipeline: makeSub('first', 'first') } },
        { type: 'subflow', config: { name: 'second', pipeline: makeSub('second', 'second') } },
        { type: 'subflow', config: { name: 'third', pipeline: makeSub('third', 'third') } },
      ],
    }

    await new Runner(parentPipeline, globalContext).start()

    expect(order).toEqual(['first', 'second', 'third'])
  })
})
