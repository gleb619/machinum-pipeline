import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import { Store } from '../../src/store.js'
import type { Envelope, Pipeline, RunStateData, Tool } from '../../src/types.js'
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

async function readState(runner: Runner): Promise<RunStateData> {
  const runId = runner.getRunId()
  if (!runId) throw new Error('runner has no run id')
  const raw = await readFile(join(projectRoot, '.mt', 'runs', runId, 'state.json'), 'utf-8')
  return JSON.parse(raw) as RunStateData
}

describe('runner log writes', () => {
  let logWrites: number
  const rejections: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason)
  }

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'mt-log-'))
    sourceItems.length = 0
    logWrites = 0
    rejections.length = 0
    process.on('unhandledRejection', onUnhandled)

    // The log directory is the only thing that fails: a full disk (ENOSPC), a
    // read-only mount, or a run dir removed mid-run all look like this.
    vi.spyOn(Store.prototype, 'ensureDir').mockImplementation(async function (
      this: Store,
      ...parts: string[]
    ) {
      if (parts.includes('logs')) {
        logWrites++
        throw new Error('ENOSPC: no space left on device')
      }
      return originalEnsureDir.call(this, ...parts)
    })
    vi.spyOn(Store.prototype, 'append').mockImplementation(async function (
      this: Store,
      content: string,
      ...parts: string[]
    ) {
      if (parts.includes('logs')) {
        logWrites++
        throw new Error('ENOSPC: no space left on device')
      }
      return originalAppend.call(this, content, ...parts)
    })
  })

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
    vi.restoreAllMocks()
  })

  it('finishes the run when a log write fails, without an unhandled rejection', async () => {
    sourceItems.push({ id: 'ex-log', variables: [], item: 'a', meta: {} })

    const runner = new Runner(pipeline(), context())
    await runner.start()

    // Unhandled rejections surface on the next event-loop turn.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(logWrites).toBeGreaterThan(0)
    expect(rejections).toEqual([])
    expect((await readState(runner)).state).toBe('done')
  })
})
