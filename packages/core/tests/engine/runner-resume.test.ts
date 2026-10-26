import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import type { Envelope, Pipeline, RunStateData, Tool } from '../../src/types.js'
import { registry } from '../../src/uri.js'

/** Every state.json payload the runner persists during a test. */
const persistedStates: RunStateData[] = []
/** Which source entry points ran, in order: `start` or `resume:<cursor>`. */
const sourceCalls: string[] = []
/** Items handed to the target, in write order. */
const written: number[] = []
/** Raw lines appended to run files (events.jsonl), in order. */
const appendedLines: string[] = []

const items = [1, 2, 3, 4, 5]
/** Value the tool throws on; 0 disables the failure. */
let failOn = 0

vi.mock('../../src/store.js', () => ({
  Store: class {
    ensureDir = vi.fn().mockResolvedValue(undefined)
    writeJson = vi.fn().mockImplementation(async (data: unknown, ...path: string[]) => {
      if (path[path.length - 1] === 'state.json') persistedStates.push(data as RunStateData)
    })
    readJson = vi.fn().mockImplementation(async () => {
      const last = persistedStates.at(-1)
      // Round-trip through JSON like a real disk read, so the resumed tree is never
      // the same object the test (or the runner) still holds.
      return last
        ? (JSON.parse(JSON.stringify(last)) as RunStateData)
        : { state: 'running', checkpoint: { stepId: 'root' } }
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

function envelopesFrom(startAt: number): Array<Envelope<{ value: number }>> {
  return items
    .slice(startAt)
    .map((value) => ({ id: 'ex-test', variables: [], item: { value }, meta: {} }))
}

registry.registerSource('cursor-source', (uri) => ({
  uri: uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    sourceCalls.push('start')
    for (const env of envelopesFrom(0)) yield env
  },
  async *resume(_ctx, cursor: unknown) {
    sourceCalls.push(`resume:${String(cursor)}`)
    for (const env of envelopesFrom(typeof cursor === 'number' ? cursor : 0)) yield env
  },
}))

/** Source without a `resume()` — resume must fall back to `start()`. */
registry.registerSource('plain-source', (uri) => ({
  uri: uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    sourceCalls.push('start')
    for (const env of envelopesFrom(0)) yield env
  },
}))

registry.registerTarget('cursor-target', (uri) => ({
  uri: uri.raw,
  async open() {},
  async write(env: Envelope<unknown>) {
    written.push((env.item as { value: number }).value)
  },
  async close() {},
}))

const globalContext: GlobalContext = {
  project: { name: 'test', root: '/tmp/test-cursor' },
  defaults: {
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' as const },
    onError: 'fail-run' as const,
    concurrency: 2,
  },
  settings: {},
  env: {},
}

const gateTool: Tool<{ value: number }, { value: number }> = {
  name: 'gate',
  version: '1.0.0',
  mdDescription: 'passes items through, throws on the configured value',
  invoke: async (env) => {
    if (env.item.value === failOn) throw new Error(`gate exploded on ${env.item.value}`)
    return env
  },
}

function cursorPipeline(id: string, sourceScheme: string): Pipeline {
  return {
    id,
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' as const },
    onError: 'fail-run' as const,
    steps: [
      { type: 'source', config: { uri: `${sourceScheme}://in` } },
      { type: 'tool', config: { name: 'gate', tool: gateTool, concurrency: '2' } },
      { type: 'target', config: { uri: 'cursor-target://out' } },
    ],
  }
}

/** Last run state the runner persisted (what lands in state.json). */
function lastState(): RunStateData {
  const state = persistedStates.at(-1)
  if (!state) throw new Error('runner persisted no state')
  return state
}

describe('runner source cursor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persistedStates.length = 0
    sourceCalls.length = 0
    written.length = 0
    appendedLines.length = 0
    failOn = 0
  })

  it('records the source cursor in the checkpoint as envelopes reach the target', async () => {
    failOn = 3

    await expect(
      new Runner(cursorPipeline('cursor-record', 'cursor-source'), globalContext).start(),
    ).rejects.toThrow('gate exploded on 3')

    expect(written).toEqual([1, 2])
    // Concurrency 2 keeps items 3 and 4 in flight: only envelopes that actually reached
    // the target may be counted, or a resume would skip work that never completed.
    expect(lastState().checkpoint.cursor).toBe(2)
  })

  it('resumes through Source.resume with the recorded cursor', async () => {
    failOn = 3

    await expect(
      new Runner(cursorPipeline('cursor-resume', 'cursor-source'), globalContext).start(),
    ).rejects.toThrow('gate exploded on 3')

    failOn = 0
    sourceCalls.length = 0
    written.length = 0

    await new Runner(cursorPipeline('cursor-resume', 'cursor-source'), globalContext).resume(
      'run-under-test',
    )

    expect(sourceCalls).toEqual(['resume:2'])
    expect(written).toEqual([3, 4, 5])
    expect(lastState().state).toBe('done')
    expect(lastState().checkpoint.cursor).toBe(5)
  })

  it('resume twice after a failure processes every envelope exactly once (T098)', async () => {
    // Guards the waypoint contract: a resumable source with a deterministic
    // ordering (e.g. md:// dir, sorted file walk) must skip `cursor`
    // envelopes on resume — re-yielding them makes the runner double-count.
    failOn = 3

    await expect(
      new Runner(cursorPipeline('cursor-twice', 'cursor-source'), globalContext).start(),
    ).rejects.toThrow('gate exploded on 3')

    await expect(
      new Runner(cursorPipeline('cursor-twice', 'cursor-source'), globalContext).resume(
        'run-under-test',
      ),
    ).rejects.toThrow('gate exploded on 3')
    // The first resume must not re-deliver envelopes 1 and 2.
    expect(written).toEqual([1, 2])

    failOn = 0
    sourceCalls.length = 0
    written.length = 0

    await new Runner(cursorPipeline('cursor-twice', 'cursor-source'), globalContext).resume(
      'run-under-test',
    )

    expect(sourceCalls).toEqual(['resume:2'])
    expect(written).toEqual([3, 4, 5])
    expect(lastState().checkpoint.cursor).toBe(5)
  })

  it('falls back to start() and replays in full when the source has no resume', async () => {
    failOn = 3

    await expect(
      new Runner(cursorPipeline('plain-resume', 'plain-source'), globalContext).start(),
    ).rejects.toThrow('gate exploded on 3')

    failOn = 0
    sourceCalls.length = 0
    written.length = 0

    await new Runner(cursorPipeline('plain-resume', 'plain-source'), globalContext).resume(
      'run-under-test',
    )

    expect(sourceCalls).toEqual(['start'])
    expect(written).toEqual(items)
    expect(lastState().checkpoint.cursor).toBe(5)
  })

  it('starts from the beginning when no cursor was ever recorded', async () => {
    await new Runner(cursorPipeline('cursor-absent', 'cursor-source'), globalContext).start()

    expect(sourceCalls).toEqual(['start'])
    expect(written).toEqual(items)
  })

  it('records pipelineFile/pipelineName options in state.json', async () => {
    await new Runner(cursorPipeline('cursor-file', 'cursor-source'), globalContext, {
      pipelineFile: 'pipelines/example.ts',
      pipelineName: 'myPipeline',
    }).start()

    expect(lastState().pipelineFile).toBe('pipelines/example.ts')
    expect(lastState().pipelineName).toBe('myPipeline')
  })

  it('rejects resume of a done run without mutating state or emitting resumed (T133)', async () => {
    await new Runner(cursorPipeline('cursor-done', 'cursor-source'), globalContext).start()
    expect(lastState().state).toBe('done')

    const statesBefore = persistedStates.length
    await expect(
      new Runner(cursorPipeline('cursor-done', 'cursor-source'), globalContext).resume(
        'run-under-test',
      ),
    ).rejects.toThrow(/already done/)

    // Nothing new persisted, no 'resumed' event appended.
    expect(persistedStates.length).toBe(statesBefore)
    expect(lastState().state).toBe('done')
    expect(appendedLines.filter((line) => line.includes('"type":"resumed"'))).toHaveLength(0)
    // No source ran either.
    expect(sourceCalls).toEqual(['start'])
  })

  it('rejects resume when the pipeline id differs from the recorded run', async () => {
    failOn = 3
    await expect(
      new Runner(cursorPipeline('cursor-mismatch', 'cursor-source'), globalContext).start(),
    ).rejects.toThrow('gate exploded on 3')

    failOn = 0
    await expect(
      new Runner(cursorPipeline('other-pipeline', 'cursor-source'), globalContext).resume(
        'run-under-test',
      ),
    ).rejects.toThrow(/pipelineId mismatch/)
  })
})
