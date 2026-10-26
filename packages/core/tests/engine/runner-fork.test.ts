import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import type { CheckpointNode, Envelope, Pipeline, RunStateData, Tool } from '../../src/types.js'
import { registry } from '../../src/uri.js'

/** Every state.json payload the runner persists during a test. */
const persistedStates: RunStateData[] = []

vi.mock('../../src/store.js', () => ({
  Store: class {
    ensureDir = vi.fn().mockResolvedValue(undefined)
    writeJson = vi.fn().mockImplementation(async (data: unknown, ...path: string[]) => {
      if (path[path.length - 1] === 'state.json') persistedStates.push(data as RunStateData)
    })
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

const sourceItems: Array<Envelope<unknown>> = []
const targetItems: Array<Envelope<unknown>> = []

registry.registerSource('fork-source', (_uri) => ({
  uri: _uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of sourceItems) yield env
  },
  async *resume() {
    for (const env of sourceItems) yield env
  },
}))

registry.registerTarget('fork-target', (_uri) => ({
  uri: _uri.raw,
  async open() {
    targetItems.length = 0
  },
  async write(env: Envelope<unknown>) {
    targetItems.push(env)
  },
  async close() {},
}))

const globalContext: GlobalContext = {
  project: { name: 'test', root: '/tmp/test-fork' },
  defaults: {
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' as const },
    onError: 'fail-run' as const,
    concurrency: 1,
  },
  settings: {},
  env: {},
}

const defaultRetry = { max: 0, backoffMs: 0, strategy: 'fixed' as const }

/** Tool that multiplies `item.value` by 10. */
function multiplierTool(name = 'multiply'): Tool<{ value: number }, { value: number }> {
  return {
    name,
    version: '1.0.0',
    mdDescription: 'Multiplies item.value by 10.',
    invoke: async (env) => ({
      ...env,
      item: { value: (env.item as { value: number }).value * 10 },
    }),
  }
}

function parentPipeline(child: Pipeline): Pipeline {
  return {
    id: 'parent',
    retry: defaultRetry,
    onError: 'fail-run',
    steps: [
      { type: 'source', config: { uri: 'fork-source://input' } },
      { type: 'fork', config: { name: 'child', pipeline: child } },
      { type: 'target', config: { uri: 'fork-target://output' } },
    ],
  }
}

function childPipeline(steps: Pipeline['steps'], id = 'child'): Pipeline {
  return { id, retry: defaultRetry, onError: 'fail-run', steps }
}

/** Last persisted checkpoint tree (what lands in .mt/runs/<id>/state.json). */
function lastCheckpoint(): CheckpointNode {
  const state = persistedStates.at(-1)
  if (!state) throw new Error('runner persisted no state')
  return state.checkpoint
}

describe('runner fork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persistedStates.length = 0
    sourceItems.length = 0
    targetItems.length = 0
  })

  it('runs child tool steps per parent envelope', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: { value: 1 }, meta: {} })
    sourceItems.push({ id: 'ex-test', variables: [], item: { value: 2 }, meta: {} })

    const child = childPipeline([
      { type: 'tool', config: { name: 'multiply', tool: multiplierTool() } },
    ])

    await new Runner(parentPipeline(child), globalContext).start()

    expect(targetItems.map((env) => (env.item as { value: number }).value)).toEqual([10, 20])
  })

  it('supports batch/flatMap/tap inside the forked child', async () => {
    sourceItems.push({
      id: 'ex-test',
      variables: [],
      item: { value: 1 },
      meta: { chapterId: 'c1' },
    })
    sourceItems.push({
      id: 'ex-test',
      variables: [],
      item: { value: 2 },
      meta: { chapterId: 'c2' },
    })

    const tapped: Envelope<unknown>[] = []
    const child = childPipeline(
      [
        { type: 'batch', config: { size: 2 } },
        { type: 'tap', config: { fn: async (env: Envelope<unknown>) => void tapped.push(env) } },
        {
          type: 'flatmap',
          config: { fn: async (group: unknown) => (group as unknown[]).flatMap((x) => [x, x]) },
        },
        { type: 'tool', config: { name: 'multiply', tool: multiplierTool() } },
      ],
      'full-child',
    )

    await new Runner(parentPipeline(child), globalContext).start()

    // Each parent envelope is forked on its own: batch groups it alone, flatMap doubles it.
    // tap sees the full envelope: item is the batch group, meta carries the parent envelope's keys.
    expect(tapped.map((env) => env.item)).toEqual([[{ value: 1 }], [{ value: 2 }]])
    expect(tapped.map((env) => env.meta.chapterId)).toEqual(['c1', 'c2'])
    expect(targetItems.map((env) => (env.item as { value: number }).value)).toEqual([
      10, 10, 20, 20,
    ])
    expect(targetItems[0]?.meta.chapterId).toBe('c1')
    expect(targetItems[3]?.meta.chapterId).toBe('c2')
  })

  it('supports a target inside the forked child (child output is a sink)', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: { value: 3 }, meta: {} })

    const childWrites: Array<Envelope<unknown>> = []
    registry.registerTarget('fork-child-target', (_uri) => ({
      uri: _uri.raw,
      async open() {},
      async write(env: Envelope<unknown>) {
        childWrites.push(env)
      },
      async close() {},
    }))

    const child = childPipeline([
      { type: 'tool', config: { name: 'multiply', tool: multiplierTool() } },
      { type: 'target', config: { uri: 'fork-child-target://out' } },
    ])

    await new Runner(parentPipeline(child), globalContext).start()

    expect(childWrites.map((env) => (env.item as { value: number }).value)).toEqual([30])
    expect(targetItems).toHaveLength(0)
  })

  it('records one nested checkpoint node per forked envelope', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: { value: 1 }, meta: {} })
    sourceItems.push({ id: 'ex-test', variables: [], item: { value: 2 }, meta: {} })

    const child = childPipeline([
      { type: 'tool', config: { name: 'multiply', tool: multiplierTool() } },
    ])

    await new Runner(parentPipeline(child), globalContext).start()

    const nodes = lastCheckpoint().children ?? []
    expect(nodes.map((node) => node.stepId.replace(/^.*\//, ''))).toEqual(['fork-0', 'fork-1'])
    expect(nodes.every((node) => node.state === 'done')).toBe(true)
  })

  it('fails the parent run when the child pipeline throws', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: { value: 1 }, meta: {} })

    const child = childPipeline([
      {
        type: 'tap',
        config: {
          fn: async () => {
            throw new Error('child exploded')
          },
        },
      },
    ])

    await expect(new Runner(parentPipeline(child), globalContext).start()).rejects.toThrow(
      'child exploded',
    )
  })
})
