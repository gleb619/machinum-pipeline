import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import type { CheckpointNode, Envelope, Pipeline, RunStateData, Tool } from '../../src/types.js'
import { registry } from '../../src/uri.js'

/** Every state.json payload the runner persists during a test. */
const persistedStates: RunStateData[] = []
/** Every line appended to the store (dead-letter queue, logs). */
const appendedLines: string[] = []

vi.mock('../../src/store.js', () => ({
  Store: class {
    ensureDir = vi.fn().mockResolvedValue(undefined)
    writeJson = vi.fn().mockImplementation(async (data: unknown, ...path: string[]) => {
      if (path[path.length - 1] === 'state.json') persistedStates.push(data as RunStateData)
    })
    readJson = vi.fn().mockImplementation(async () => {
      const last = persistedStates.at(-1)
      return last ? { ...last } : { state: 'running', checkpoint: { stepId: 'root' } }
    })
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

const sourceItems: Array<Envelope<unknown>> = []
const targetItems: Array<Envelope<unknown>> = []

registry.registerSource('policy-source', (_uri) => ({
  uri: _uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of sourceItems) yield env
  },
  async *resume() {
    for (const env of sourceItems) yield env
  },
}))

registry.registerTarget('policy-target', (_uri) => ({
  uri: _uri.raw,
  async open() {},
  async write(env: Envelope<unknown>) {
    targetItems.push(env)
  },
  async close() {},
}))

const globalContext: GlobalContext = {
  project: { name: 'test', root: '/tmp/test-policy' },
  defaults: {
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' as const },
    onError: 'fail-run' as const,
    concurrency: 2,
  },
  settings: {},
  env: {},
}

const defaultRetry = { max: 0, backoffMs: 0, strategy: 'fixed' as const }

/** Tool that passes items through, failing on `boom: true` after an optional delay. */
function passThroughTool(name = 'passthrough'): Tool<{ value: number; boom?: boolean }, unknown> {
  return {
    name,
    version: '1.0.0',
    mdDescription: 'echoes the item, throws when boom is set',
    exec: 'inproc',
    invoke: async (env) => {
      const item = env.item as { value: number; boom?: boolean }
      if (item.value === 1) await new Promise((resolve) => setTimeout(resolve, 30))
      if (item.boom) throw new Error(`${name} exploded on ${item.value}`)
      return env as Envelope<unknown>
    },
  }
}

function policyPipeline(id: string, onError: Pipeline['onError'], concurrency: number): Pipeline {
  return {
    id,
    retry: defaultRetry,
    onError,
    steps: [
      { type: 'source', config: { uri: 'policy-source://in' } },
      {
        type: 'tool',
        config: { name: 'passthrough', tool: passThroughTool(), concurrency: String(concurrency) },
      },
      { type: 'target', config: { uri: 'policy-target://out' } },
    ],
  }
}

/** Last persisted run state (what lands in .mt/runs/<id>/state.json). */
function lastState(): RunStateData {
  const state = persistedStates.at(-1)
  if (!state) throw new Error('runner persisted no state')
  return state
}

function valuesWritten(): number[] {
  return targetItems.map((env) => (env.item as { value: number }).value)
}

describe('runner error policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persistedStates.length = 0
    appendedLines.length = 0
    sourceItems.length = 0
    targetItems.length = 0
  })

  it('fails the run when a fail-run tool throws', async () => {
    sourceItems.push({ item: { value: 1, boom: true }, meta: {} })

    await expect(
      new Runner(policyPipeline('fail-run-single', 'fail-run', 1), globalContext).start(),
    ).rejects.toThrow('passthrough exploded on 1')

    expect(lastState().state).toBe('failed')
    expect(valuesWritten()).toEqual([])
  })

  it('does not let a sibling success mask a fail-run rejection', async () => {
    // Item 1 resolves slowly, item 2 rejects quickly: a first-*success* race would swallow it.
    sourceItems.push({ item: { value: 1 }, meta: {} })
    sourceItems.push({ item: { value: 2, boom: true }, meta: {} })

    await expect(
      new Runner(policyPipeline('fail-run-masked', 'fail-run', 2), globalContext).start(),
    ).rejects.toThrow('passthrough exploded on 2')

    expect(lastState().state).toBe('failed')
    expect(valuesWritten()).toEqual([1])
  })

  it('marks the root checkpoint failed with the error message', async () => {
    sourceItems.push({ item: { value: 1, boom: true }, meta: {} })

    await expect(
      new Runner(policyPipeline('fail-run-checkpoint', 'fail-run', 1), globalContext).start(),
    ).rejects.toThrow()

    const checkpoint = lastState().checkpoint as CheckpointNode
    expect(checkpoint.state).toBe('failed')
    expect(checkpoint.error).toContain('passthrough exploded on 1')
  })

  it('drops the item and completes the run under skip-item', async () => {
    sourceItems.push({ item: { value: 1 }, meta: {} })
    sourceItems.push({ item: { value: 2, boom: true }, meta: {} })
    sourceItems.push({ item: { value: 3 }, meta: {} })

    await new Runner(policyPipeline('skip-item', 'skip-item', 2), globalContext).start()

    expect(valuesWritten()).toEqual([1, 3])
    expect(lastState().state).toBe('done')
  })

  it('writes a dead-letter entry and completes the run under dead-letter', async () => {
    sourceItems.push({ item: { value: 1 }, meta: {} })
    sourceItems.push({ item: { value: 2, boom: true }, meta: {} })

    await new Runner(policyPipeline('dead-letter', 'dead-letter', 1), globalContext).start()

    expect(valuesWritten()).toEqual([1])
    expect(lastState().state).toBe('done')

    const entry = appendedLines
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { error?: { message?: string } })
      .find((json) => json.error?.message)
    expect(entry?.error?.message).toContain('passthrough exploded on 2')
  })

  it('re-runs a failed run on resume instead of tripping the state machine', async () => {
    sourceItems.push({ item: { value: 1, boom: true }, meta: {} })

    await expect(
      new Runner(policyPipeline('fail-run-resume', 'fail-run', 1), globalContext).start(),
    ).rejects.toThrow('passthrough exploded on 1')

    // The state loaded back is `failed`; resume must re-run, not fail on an invalid transition.
    let resumeError: Error | undefined
    try {
      await new Runner(policyPipeline('fail-run-resume', 'fail-run', 1), globalContext).resume(
        'run-under-test',
      )
    } catch (error) {
      resumeError = error as Error
    }

    expect(resumeError?.message).toContain('passthrough exploded on 1')
    expect(lastState().state).toBe('failed')
  })
})
