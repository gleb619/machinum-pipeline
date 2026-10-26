import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import type { Envelope, Pipeline, RunEvent, Tool } from '../../src/types.js'
import { registry } from '../../src/uri.js'

const sourceItems: Array<Envelope<unknown>> = []
const written: Array<Envelope<unknown>> = []

registry.registerSource('sub-source', (_uri) => ({
  uri: _uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of sourceItems) yield env
  },
  async *resume() {
    for (const env of sourceItems) yield env
  },
}))

registry.registerTarget('sub-target', (_uri) => ({
  uri: _uri.raw,
  async open() {},
  async write(env: Envelope<unknown>) {
    written.push(env)
  },
  async close() {},
}))

const defaultRetry = { max: 0, backoffMs: 0, strategy: 'fixed' as const }

const echoTool: Tool<unknown, unknown> = {
  name: 'echo',
  version: '1.0.0',
  mdDescription: 'Passes the envelope through unchanged.',
  invoke: async (env) => env,
}

const explodeTool: Tool<unknown, unknown> = {
  name: 'exploder',
  version: '1.0.0',
  mdDescription: 'Always throws.',
  invoke: async () => {
    throw new Error('exploder exploded')
  },
}

let projectRoot: string

function context(): GlobalContext {
  return {
    project: { name: 'sub-test', root: projectRoot },
    defaults: {
      retry: defaultRetry,
      onError: 'fail-run' as const,
      concurrency: 1,
    },
    settings: {},
    env: {},
  }
}

function pipeline(id: string, tool: Tool<unknown, unknown>): Pipeline {
  return {
    id,
    retry: defaultRetry,
    onError: 'fail-run',
    steps: [
      { type: 'source', config: { uri: 'sub-source://in' } },
      { type: 'tool', config: { name: tool.name, tool } },
      { type: 'target', config: { uri: 'sub-target://out' } },
    ],
  }
}

describe('runner event subscription', () => {
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'mt-sub-'))
    sourceItems.length = 0
    written.length = 0
  })

  it('delivers started, step-done(s), and done in order to a subscribed listener', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: 'a', meta: {} })

    const received: RunEvent[] = []
    const runner = new Runner(pipeline('sub-happy', echoTool), context())
    runner.subscribeEvents((event) => {
      received.push(event)
    })

    await runner.start()

    expect(received.map((e) => e.type)).toEqual([
      'started',
      'step-done',
      'step-done',
      'step-done',
      'done',
    ])
    expect(received[0]?.runId).toBe(runner.getRunId())
    expect(received.at(-1)?.runId).toBe(runner.getRunId())
  })

  it('seeds initial listeners via RunnerOptions.events', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: 'a', meta: {} })

    const received: RunEvent[] = []
    const runner = new Runner(pipeline('sub-opts', echoTool), context(), {
      events: [
        (event) => {
          received.push(event)
        },
      ],
    })

    await runner.start()

    expect(received.map((e) => e.type)).toEqual([
      'started',
      'step-done',
      'step-done',
      'step-done',
      'done',
    ])
  })

  it('delivers a failed event when the pipeline throws', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: 'a', meta: {} })

    const received: RunEvent[] = []
    const runner = new Runner(pipeline('sub-fail', explodeTool), context())
    runner.subscribeEvents((event) => {
      received.push(event)
    })

    await expect(runner.start()).rejects.toThrow('exploder exploded')

    expect(received.at(-1)?.type).toBe('failed')
    expect(received.at(-1)?.error).toContain('exploder exploded')
    expect(received.filter((e) => e.type === 'done')).toHaveLength(0)
  })

  it('never fails the run when a listener throws or rejects', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: 'a', meta: {} })

    const runner = new Runner(pipeline('sub-throwing', echoTool), context())
    runner.subscribeEvents(() => {
      throw new Error('sync listener boom')
    })
    runner.subscribeEvents(() => Promise.reject(new Error('async listener boom')))
    // A healthy listener still receives everything.
    const received: RunEvent[] = []
    runner.subscribeEvents((event) => {
      received.push(event)
    })

    await runner.start()

    expect(received.map((e) => e.type).at(-1)).toBe('done')
    expect(written).toHaveLength(1)
  })

  it('stops delivery after unsubscribe', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: 'a', meta: {} })

    const received: RunEvent[] = []
    const runner = new Runner(pipeline('sub-unsub', echoTool), context())
    const unsubscribe = runner.subscribeEvents((event) => {
      received.push(event)
    })

    // Unsubscribe before start — nothing may be delivered.
    unsubscribe()
    await runner.start()

    expect(received).toHaveLength(0)
  })

  it('does not await slow listeners before finishing the run', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: 'a', meta: {} })

    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runner = new Runner(pipeline('sub-slow', echoTool), context())
    runner.subscribeEvents(() => gate)

    const startedAt = Date.now()
    const finished = runner.start()
    // The 'started' event fires before any step — the listener pends on the gate,
    // but the run must proceed to completion regardless.
    await vi.waitFor(
      () => {
        expect(written).toHaveLength(1)
      },
      { timeout: 3000, interval: 20 },
    )
    await finished
    expect(Date.now() - startedAt).toBeLessThan(2000)
    release()
  })
})
