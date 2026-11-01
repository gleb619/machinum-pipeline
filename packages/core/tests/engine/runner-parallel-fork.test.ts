import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import { ITEM_VARIABLE, getVariable } from '../../src/exchange.js'
import type { CheckpointNode, Envelope, Pipeline, RunStateData } from '../../src/types.js'
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

registry.registerSource('parallel-fork-source', (uri) => ({
  uri: uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of sourceItems) yield env
  },
  async *resume() {
    for (const env of sourceItems) yield env
  },
}))

registry.registerTarget('parallel-fork-target', (uri) => ({
  uri: uri.raw,
  async open() {
    targetItems.length = 0
  },
  async write(env: Envelope<unknown>) {
    targetItems.push(env)
  },
  async close() {},
}))

const globalContext: GlobalContext = {
  project: { name: 'test', root: '/tmp/test-parallel-fork' },
  defaults: {
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' as const },
    onError: 'fail-run' as const,
    concurrency: 1,
  },
  settings: {},
  env: {},
}

const defaultRetry = { max: 0, backoffMs: 0, strategy: 'fixed' as const }

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function branchPipeline(id: string, steps: Pipeline['steps']): Pipeline {
  return { id, retry: defaultRetry, onError: 'fail-run', steps }
}

function parentPipeline(steps: Pipeline['steps']): Pipeline {
  return {
    id: 'parallel-parent',
    retry: defaultRetry,
    onError: 'fail-run',
    steps: [
      { type: 'source', config: { uri: 'parallel-fork-source://in' } },
      ...steps,
      { type: 'target', config: { uri: 'parallel-fork-target://out' } },
    ],
  }
}

function parallelForkStep(branches: readonly Pipeline[]): Pipeline['steps'][number] {
  return {
    type: 'fork',
    config: { name: 'views', pipelines: [...branches], parallel: true },
  }
}

function allNodes(node: CheckpointNode): CheckpointNode[] {
  return [node, ...(node.children ?? []).flatMap((child) => allNodes(child))]
}

function stateSnapshot(state: RunStateData['state']): CheckpointNode {
  const snapshot = [...persistedStates].reverse().find((entry) => entry.state === state)
  if (!snapshot) throw new Error(`runner never persisted a '${state}' state`)
  return snapshot.checkpoint
}

describe('runner parallel fork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persistedStates.length = 0
    sourceItems.length = 0
    targetItems.length = 0
  })

  it('runs all branches concurrently for one parent envelope', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: { value: 1 }, meta: {} })

    const starts: number[] = []
    const ends: number[] = []
    let arrived = 0
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const branch = (id: string): Pipeline =>
      branchPipeline(id, [
        {
          type: 'tap',
          config: {
            fn: async () => {
              starts.push(Date.now())
              arrived += 1
              if (arrived === 3) release()
              await Promise.race([
                gate,
                delay(2000).then(() => {
                  throw new Error('parallel branches did not overlap')
                }),
              ])
              await delay(5)
              ends.push(Date.now())
            },
          },
        },
      ])

    await new Runner(
      parentPipeline([parallelForkStep([branch('a'), branch('b'), branch('c')])]),
      globalContext,
    ).start()

    expect(starts).toHaveLength(3)
    expect(ends).toHaveLength(3)
    // All branches started before any branch finished: impossible if the runner awaited them
    // one after another.
    expect(Math.max(...starts)).toBeLessThan(Math.min(...ends))
  })

  it('merges branch outputs in declaration order, per parent envelope', async () => {
    sourceItems.push(
      { id: 'ex-a', variables: [], item: { parent: 'p0' }, meta: {} },
      { id: 'ex-b', variables: [], item: { parent: 'p1' }, meta: {} },
    )

    const emitting = (id: string, tag: string, delayMs: number): Pipeline =>
      branchPipeline(id, [
        {
          type: 'flatmap',
          config: {
            fn: async (item: unknown) => {
              await delay(delayMs)
              const parent = (item as { parent: string }).parent
              return [`${parent}:${tag}:0`, `${parent}:${tag}:1`]
            },
          },
        },
      ])

    // Completion order (b, c, a) deliberately differs from declaration order (a, b, c).
    await new Runner(
      parentPipeline([
        parallelForkStep([emitting('a', 'a', 20), emitting('b', 'b', 0), emitting('c', 'c', 10)]),
      ]),
      globalContext,
    ).start()

    expect(targetItems.map((env) => env.item)).toEqual([
      'p0:a:0',
      'p0:a:1',
      'p0:b:0',
      'p0:b:1',
      'p0:c:0',
      'p0:c:1',
      'p1:a:0',
      'p1:a:1',
      'p1:b:0',
      'p1:b:1',
      'p1:c:0',
      'p1:c:1',
    ])
  })

  it('fails the run when any branch fails, after settling every branch', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: { value: 1 }, meta: {} })

    const slower = (id: string): Pipeline =>
      branchPipeline(id, [{ type: 'tap', config: { fn: async () => await delay(10) } }])
    const failing = branchPipeline('failing', [
      {
        type: 'tap',
        config: {
          fn: async () => {
            throw new Error('branch exploded')
          },
        },
      },
    ])

    await expect(
      new Runner(
        parentPipeline([parallelForkStep([slower('a'), failing, slower('c')])]),
        globalContext,
      ).start(),
    ).rejects.toThrow('branch exploded')

    const nodes = allNodes(stateSnapshot('failed')).filter((node) =>
      /\/branch-\d+$/.test(node.stepId),
    )
    expect(nodes).toHaveLength(3)
    expect(nodes.find((node) => node.stepId.endsWith('/branch-0'))?.state).toBe('done')
    const failed = nodes.find((node) => node.stepId.endsWith('/branch-1'))
    expect(failed?.state).toBe('failed')
    expect(failed?.error).toBe('branch exploded')
    expect(nodes.find((node) => node.stepId.endsWith('/branch-2'))?.state).toBe('done')
  })

  it('records one deterministic checkpoint node per parent/branch', async () => {
    sourceItems.push(
      { id: 'ex-a', variables: [], item: { value: 1 }, meta: {} },
      { id: 'ex-b', variables: [], item: { value: 2 }, meta: {} },
    )

    const noop = (id: string): Pipeline =>
      branchPipeline(id, [{ type: 'tap', config: { fn: async () => {} } }])

    await new Runner(
      parentPipeline([parallelForkStep([noop('a'), noop('b'), noop('c')])]),
      globalContext,
    ).start()

    const nodes = allNodes(stateSnapshot('done')).filter((node) =>
      /\/branch-\d+$/.test(node.stepId),
    )
    expect(nodes).toHaveLength(6)
    const first = nodes[0]?.stepId
    if (!first) throw new Error('no branch checkpoint nodes')
    const forkId = first.slice(0, first.indexOf('/fork-'))
    expect(forkId).toMatch(/^fork-views-\d+$/)
    expect(nodes.map((node) => node.stepId)).toEqual([
      `${forkId}/fork-0/branch-0`,
      `${forkId}/fork-0/branch-1`,
      `${forkId}/fork-0/branch-2`,
      `${forkId}/fork-1/branch-0`,
      `${forkId}/fork-1/branch-1`,
      `${forkId}/fork-1/branch-2`,
    ])
    expect(nodes.every((node) => node.state === 'done')).toBe(true)
  })

  it('isolates in-place payload mutations between branches', async () => {
    const original = { nested: { value: 1 }, list: [1, 2] }
    sourceItems.push({ id: 'ex-test', variables: [], item: original, meta: {} })

    const seenByB: unknown[] = []
    const seenByC: unknown[] = []

    const mutating = branchPipeline('a', [
      {
        type: 'tap',
        config: {
          fn: async (env: Envelope<unknown>) => {
            const payload = env.item as { nested: { value: number } }
            payload.nested.value = 99
            await delay(10)
          },
        },
      },
    ])
    const observing = (id: string, seen: unknown[]): Pipeline =>
      branchPipeline(id, [
        {
          type: 'tap',
          config: {
            fn: async (env: Envelope<unknown>) => {
              await delay(20)
              seen.push(env.item)
            },
          },
        },
      ])

    await new Runner(
      parentPipeline([
        parallelForkStep([mutating, observing('b', seenByB), observing('c', seenByC)]),
      ]),
      globalContext,
    ).start()

    expect(original).toEqual({ nested: { value: 1 }, list: [1, 2] })
    expect(seenByB).toEqual([{ nested: { value: 1 }, list: [1, 2] }])
    expect(seenByC).toEqual([{ nested: { value: 1 }, list: [1, 2] }])
    expect(targetItems).toHaveLength(3)
    expect((targetItems[0]?.item as { nested: { value: number } }).nested.value).toBe(99)
    expect((targetItems[1]?.item as { nested: { value: number } }).nested.value).toBe(1)
    expect((targetItems[2]?.item as { nested: { value: number } }).nested.value).toBe(1)
    for (const output of targetItems) {
      expect(getVariable(output, ITEM_VARIABLE)).toBe(output.item)
    }
  })
})
