import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtomicStreamWriter } from '../../src/atomic.js'
import type { GlobalContext } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import type { Envelope, Pipeline, RunStateData, Target } from '../../src/types.js'
import { registry } from '../../src/uri.js'

/**
 * Crash-resume (UC015/UC016): state.json must be persisted mid-run, and the
 * persisted source cursor may only reflect output the target has durably
 * committed. Simulated crash = the Runner is abandoned mid-stream (no
 * pause/done/fail persist) and a fresh Runner resumes from the last
 * persisted state.
 */

/** Every state.json payload the runner persisted during a test. */
const persistedStates: RunStateData[] = []
/** Which source entry points ran, in order: `start` or `resume:<cursor>`. */
const sourceCalls: string[] = []
/** Items handed to the append target, in write order. */
const appendWritten: number[] = []
/** Durably committed count reported by the append target. */
let appendCommitted = 0

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

const items = Array.from({ length: 10 }, (_, i) => i)

registry.registerSource('crash-source', (uri) => ({
  uri: uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    sourceCalls.push('start')
    for (const value of items) yield { item: { value }, meta: {} }
  },
  async *resume(_ctx, cursor: unknown) {
    sourceCalls.push(`resume:${String(cursor)}`)
    const from = typeof cursor === 'number' ? cursor : 0
    for (const value of items.slice(from)) yield { item: { value }, meta: {} }
  },
}))

/** Append-style target: every write is durable immediately, exposes it via checkpoint(). */
registry.registerTarget('append-target', (uri) => ({
  uri: uri.raw,
  async open() {
    appendCommitted = 0
  },
  async write(env: Envelope<unknown>) {
    appendWritten.push((env.item as { value: number }).value)
    appendCommitted = appendWritten.length
  },
  async close() {},
  async checkpoint() {
    return appendCommitted
  },
}))

/** Gate tool: passes items through; item 6 parks forever while `parkItem6` is set (simulates the killed process). */
let parkItem6 = false
const gateTool = {
  name: 'crash-gate',
  version: '1.0.0',
  mdDescription: 'passes items through; parks item 6 while crashing',
  invoke: async (env: Envelope<{ value: number }>) => {
    if (env.item.value === 6 && parkItem6) await new Promise(() => {})
    return { item: env.item, meta: env.meta }
  },
}

const globalContext: GlobalContext = {
  project: { name: 'test', root: '/tmp/test-crash-resume' },
  defaults: {
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' as const },
    onError: 'fail-run' as const,
    concurrency: 1,
  },
  // Persist every 2 target writes so a mid-run snapshot exists before the "crash".
  settings: { 'runner.persist.every': 2 },
  env: {},
}

function crashPipeline(id: string, targetScheme: string): Pipeline {
  return {
    id,
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' as const },
    onError: 'fail-run' as const,
    steps: [
      { type: 'source', config: { uri: 'crash-source://in' } },
      { type: 'tool', config: { name: 'crash-gate', tool: gateTool, concurrency: '1' } },
      { type: 'target', config: { uri: `${targetScheme}://out` } },
    ],
  }
}

/** Wait until `predicate` holds, polling — the abandoned runner is stuck mid-run. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Abandon a runner once 6 items reached the target: item 6's tool never resolves. */
async function abandonAfterSix(targetScheme: string): Promise<void> {
  // Fire-and-forget: never awaited, never paused/done/failed — the "crash".
  void new Runner(crashPipeline(`crash-${targetScheme}`, targetScheme), globalContext).start()
  await waitFor(() => appendWritten.length === 6 || sourceCalls.length > 0)
  // Give the throttled persist a tick to flush the 6th write's snapshot.
  await waitFor(() => persistedStates.length >= 3)
}

describe('runner crash resume (UC015/UC016)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persistedStates.length = 0
    sourceCalls.length = 0
    appendWritten.length = 0
    appendCommitted = 0
    parkItem6 = true
  })

  it('append-style target: resume continues from the durably committed position', async () => {
    await abandonAfterSix('append-target')

    const midRun = persistedStates.at(-1)
    expect(midRun?.state).toBe('running')
    // 6 writes happened, but only durably committed ones may be skipped on resume.
    expect(midRun?.checkpoint.cursor).toBe(6)

    parkItem6 = false
    await new Runner(crashPipeline('crash-append-target', 'append-target'), globalContext).resume(
      'run-under-test',
    )

    expect(sourceCalls).toEqual(['start', 'resume:6'])
    expect(appendWritten).toEqual(items)
  })

  it('temp+rename target: persisted cursor never advances past uncommitted output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-crash-resume-'))
    const filePath = join(dir, 'out.jsonl')

    // jsonl-style target: writes land in a temp file, published only on close().
    // No checkpoint() hook — the engine must treat nothing as committed mid-run.
    registry.registerTarget('tmpfile-target', (uri) => {
      let writer: AtomicStreamWriter | null = null
      const target: Target<unknown> = {
        uri: uri.raw,
        async open() {
          writer = await AtomicStreamWriter.open(filePath, 'test')
        },
        async write(env: Envelope<unknown>) {
          if (!writer) throw new Error('not open')
          await writer.write(`${JSON.stringify(env)}\n`)
        },
        async close() {
          await writer?.commit()
          writer = null
        },
      }
      return target
    })

    try {
      await abandonAfterSix('tmpfile-target')

      // Mid-run snapshots must not claim items whose output only lives in the
      // (would-be lost) temp file — the cursor stays at the pre-run position.
      for (const state of persistedStates) {
        if (state.state === 'running') expect(state.checkpoint.cursor ?? 0).toBe(0)
      }

      parkItem6 = false
      await new Runner(
        crashPipeline('crash-tmpfile-target', 'tmpfile-target'),
        globalContext,
      ).resume('run-under-test')

      const content = await readFile(filePath, 'utf-8')
      const values = content
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { item: { value: number } }).item.value)
      expect(values).toEqual(items)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

afterAll(() => {
  vi.restoreAllMocks()
})
