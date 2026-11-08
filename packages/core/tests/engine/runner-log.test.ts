import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Runner } from '../../src/engine/runner.js'
import { Store } from '../../src/store.js'
import type { Envelope, Pipeline, RunEventType, Tool } from '../../src/types.js'
import type { GlobalContext } from '../../src/types.js'
import { registry } from '../../src/uri.js'

const sourceItems: Array<Envelope<unknown>> = []

registry.registerSource('log-source', (_uri) => ({
  uri: _uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of sourceItems) yield env
  },
}))

registry.registerTarget('log-target', (_uri) => ({
  uri: _uri.raw,
  async open() {},
  async write() {},
  async close() {},
}))

const defaultRetry = { max: 0, backoffMs: 0, strategy: 'fixed' as const }

/** Logs through the run logger, like a real tool would. */
const loggingTool: Tool<unknown, unknown> = {
  name: 'logger',
  version: '1.0.0',
  mdDescription: 'Writes a log line through the run logger.',
  invoke: async (env, ctx) => {
    ctx.run.logger.info('tool logged a line')
    return env
  },
}

const originalEnsureDir = Store.prototype.ensureDir
const originalAppend = Store.prototype.append

let projectRoot: string

function context(): GlobalContext {
  return {
    project: { name: 'log-test', root: projectRoot },
    defaults: {
      retry: defaultRetry,
      onError: 'fail-run' as const,
      concurrency: 1,
    },
    settings: {},
    env: {},
  }
}

function pipeline(): Pipeline {
  return {
    id: 'log-pipeline',
    retry: defaultRetry,
    onError: 'fail-run',
    steps: [
      { type: 'source', config: { uri: 'log-source://in' } },
      { type: 'tool', config: { name: loggingTool.name, tool: loggingTool } },
      { type: 'target', config: { uri: 'log-target://out' } },
    ],
  }
}

/**
 * Run `body` while collecting process-level unhandled rejections.
 *
 * The listener is scoped to this call and always removed; the trailing macrotask is the
 * barrier that lets a rejected log-write promise reach Node's unhandled-rejection check
 * (which runs at the end of the tick, after the microtask queue drains) before the
 * collected list is read. A fixed sleep would be both slower and able to miss a late
 * rejection; a bare macrotask could race a rejected write that has not been attempted yet.
 */
async function watchUnhandledRejections(body: () => Promise<void>): Promise<unknown[]> {
  const rejections: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    await body()
    await new Promise<void>((resolve) => setImmediate(resolve))
    return rejections
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}

describe('runner log writes', () => {
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'mt-log-'))
    sourceItems.length = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('finishes the run when the log directory cannot be created', async () => {
    sourceItems.push({ id: 'ex-log', variables: [], item: 'a', meta: {} })
    const attempts: string[] = []

    // The log directory is the only thing that fails: a full disk (ENOSPC), a
    // read-only mount, or a run dir removed mid-run all look like this.
    vi.spyOn(Store.prototype, 'ensureDir').mockImplementation(async function (
      this: Store,
      ...parts: string[]
    ) {
      if (!parts.includes('logs')) return originalEnsureDir.call(this, ...parts)
      attempts.push(parts.join('/'))
      throw new Error('ENOSPC: no space left on device')
    })

    const runner = new Runner(pipeline(), context())
    const events: RunEventType[] = []
    runner.subscribeEvents((event) => {
      events.push(event.type)
    })

    const rejections = await watchUnhandledRejections(async () => {
      await runner.start()
      // `start()` resolves after the failing log write was attempted; waiting here keeps
      // the assertion meaningful even if a log write is scheduled further out.
      await vi.waitFor(() => {
        expect(attempts.length).toBeGreaterThan(0)
      })
    })

    expect(rejections).toEqual([])
    expect(events).toContain('done')
    expect(events).not.toContain('failed')
  })

  it('persists a tool log line in the step log file', async () => {
    sourceItems.push({ id: 'ex-log', variables: [], item: 'a', meta: {} })

    const runner = new Runner(pipeline(), context())
    await runner.start()

    const runId = runner.getRunId()
    expect(runId).not.toBeNull()
    const logsDir = join(projectRoot, '.mt', 'runs', runId as string, 'logs')

    // The tool's `ctx.run.logger` line is attributed to the tool's step, so it
    // lands in that step's log file. The write is fire-and-forget, so the file
    // can appear a tick after the run ended.
    await vi.waitFor(async () => {
      const files = await readdir(logsDir)
      const stepLog = files.find((f) => /^tool-logger-\d+\.log$/.test(f))
      expect(stepLog).toBeDefined()
      const content = await readFile(join(logsDir, stepLog as string), 'utf8')
      expect(content).toContain('tool logged a line')
    })
  })

  it('finishes the run when the per-step log write fails', async () => {
    sourceItems.push({ id: 'ex-log', variables: [], item: 'a', meta: {} })
    const attempts: string[] = []

    // Directory creation succeeds; the append itself fails — the shape of a full disk.
    vi.spyOn(Store.prototype, 'append').mockImplementation(async function (
      this: Store,
      content: string,
      ...parts: string[]
    ) {
      if (!parts.includes('logs')) return originalAppend.call(this, content, ...parts)
      attempts.push(parts.join('/'))
      throw new Error('ENOSPC: no space left on device')
    })

    const runner = new Runner(pipeline(), context())
    const events: RunEventType[] = []
    runner.subscribeEvents((event) => {
      events.push(event.type)
    })

    const rejections = await watchUnhandledRejections(async () => {
      await runner.start()
      await vi.waitFor(() => {
        expect(attempts.length).toBeGreaterThan(0)
      })
    })

    // The failed write is a per-step log file, so the guard really covers run logs and
    // not just some incidental write.
    expect(attempts.some((path) => /\/tool-logger-\d+\.log$/.test(path))).toBe(true)
    expect(rejections).toEqual([])
    expect(events).toContain('done')
    expect(events).not.toContain('failed')
  })
})
