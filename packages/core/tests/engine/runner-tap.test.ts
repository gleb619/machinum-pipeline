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

const mockSourceItems: Array<Envelope<unknown>> = []
const mockTargetItems: Array<Envelope<unknown>> = []

registry.registerSource('tap-source', (_uri) => ({
  uri: _uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of mockSourceItems) yield env
  },
  async *resume() {
    for (const env of mockSourceItems) yield env
  },
}))

registry.registerTarget('tap-target', (_uri) => ({
  uri: _uri.raw,
  async open() {
    mockTargetItems.length = 0
  },
  async write(env: Envelope<unknown>) {
    mockTargetItems.push(env)
  },
  async close() {},
}))

const globalContext: GlobalContext = {
  project: { name: 'test', root: '/tmp/test-tap' },
  defaults: {
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' as const },
    onError: 'fail-run' as const,
    concurrency: 1,
  },
  settings: {},
  env: {},
}

const defaultRetry = { max: 0, backoffMs: 0, strategy: 'fixed' as const }

// Tool that writes meta keys (like the real tools in @mt/tools do)
const metaWriterTool: Tool<unknown, unknown> = {
  name: 'meta-writer',
  version: '1.0.0',
  mdDescription: 'Test tool meta-writer that writes meta keys.',
  invoke: async (env: Envelope<unknown>) => ({
    ...env,
    meta: { ...env.meta, tokenCount: 42, errors: [] },
  }),
}

describe('runner tap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSourceItems.length = 0
    mockTargetItems.length = 0
  })

  it('tap receives the full envelope including meta written by an upstream tool', async () => {
    mockSourceItems.push({
      id: 'ex-test',
      variables: [],
      item: 'hello',
      meta: { source: 'tap-source' },
    })

    const seen: Envelope<unknown>[] = []
    const pipeline: Pipeline = {
      id: 'tap-envelope-pipeline',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'tap-source://input' } },
        { type: 'tool', config: { name: 'meta-writer', tool: metaWriterTool } },
        {
          type: 'tap',
          config: {
            fn: async (env: Envelope<unknown>) => {
              seen.push(env)
            },
          },
        },
        { type: 'target', config: { uri: 'tap-target://output' } },
      ],
    }

    await new Runner(pipeline, globalContext).start()

    expect(seen).toHaveLength(1)
    // meta written by the upstream tool must be visible in the tap callback
    expect(seen[0]?.meta.tokenCount).toBe(42)
    expect(seen[0]?.meta.errors).toEqual([])
    // pre-existing source meta and the item must pass through unchanged
    expect(seen[0]?.meta.source).toBe('tap-source')
    expect(seen[0]?.item).toBe('hello')
    // envelope still flows to the target untouched
    expect(mockTargetItems).toHaveLength(1)
    expect(mockTargetItems[0]?.meta.tokenCount).toBe(42)
  })
})
