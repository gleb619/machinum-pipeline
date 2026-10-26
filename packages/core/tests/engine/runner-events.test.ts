import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import type { Envelope, Pipeline, RunEvent, Tool } from '../../src/types.js'
import { registry } from '../../src/uri.js'

const sourceItems: Array<Envelope<unknown>> = []
const written: Array<Envelope<unknown>> = []

registry.registerSource('events-source', (_uri) => ({
  uri: _uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of sourceItems) yield env
  },
  async *resume() {
    for (const env of sourceItems) yield env
  },
}))

registry.registerTarget('events-target', (_uri) => ({
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
    project: { name: 'events-test', root: projectRoot },
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
      { type: 'source', config: { uri: 'events-source://in' } },
      { type: 'tool', config: { name: tool.name, tool } },
      { type: 'target', config: { uri: 'events-target://out' } },
    ],
  }
}

/** Every JSONL line the runner appended to the run's event log. */
async function events(runId: string): Promise<RunEvent[]> {
  const raw = await readFile(join(projectRoot, '.mt', 'runs', runId, 'events.jsonl'), 'utf-8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RunEvent)
}

describe('runner events.jsonl', () => {
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'mt-events-'))
    sourceItems.length = 0
    written.length = 0
  })

  it('appends started and done lines for a normal run', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: 'a', meta: {} })

    const runner = new Runner(pipeline('events-happy', echoTool), context())
    await runner.start()

    const events = await requireEvents(runner)
    expect(events.map((e) => e.type)).toEqual([
      'started',
      'step-done',
      'step-done',
      'step-done',
      'done',
    ])

    expect(events[0]?.stepId).toBeUndefined()
    expect(events[0]?.runId).toBe(runner.getRunId())
    expect(Date.parse(events[0]?.ts ?? '')).not.toBeNaN()
  })

  it('names each step-done event with its step id', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: 'a', meta: {} })

    const runner = new Runner(pipeline('events-steps', echoTool), context())
    await runner.start()

    const lines = await requireEvents(runner)
    // Step ids fall back to the step type when no `name` is configured.
    const steps = lines.filter((e) => e.type === 'step-done').map((e) => e.stepId)
    expect(steps).toEqual(['source-source-1', 'tool-echo-2', 'target-target-3'])
  })

  it('records nested fork nodes as they complete', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: 'a', meta: {} })
    sourceItems.push({ id: 'ex-test', variables: [], item: 'b', meta: {} })

    const child: Pipeline = {
      id: 'events-fork-child',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [{ type: 'tool', config: { name: 'echo', tool: echoTool } }],
    }
    const runner = new Runner(
      {
        id: 'events-fork',
        retry: defaultRetry,
        onError: 'fail-run',
        steps: [
          { type: 'source', config: { uri: 'events-source://in' } },
          { type: 'fork', config: { name: 'child', pipeline: child } },
          { type: 'target', config: { uri: 'events-target://out' } },
        ],
      },
      context(),
    )
    await runner.start()

    const steps = (await requireEvents(runner))
      .filter((e) => e.type === 'step-done')
      .map((e) => e.stepId)
    // Each forked envelope closes its own checkpoint node before the fork step itself.
    expect(steps).toContain('fork-child-2/fork-0')
    expect(steps).toContain('fork-child-2/fork-1')
    expect(steps.indexOf('fork-child-2/fork-1')).toBeLessThan(steps.indexOf('fork-child-2'))
    expect(steps.indexOf('fork-child-2')).toBeLessThan(steps.indexOf('target-target-3'))
  })

  it('ends with a failed line carrying the error message', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: 'a', meta: {} })

    const runner = new Runner(pipeline('events-fail', explodeTool), context())
    await expect(runner.start()).rejects.toThrow('exploder exploded')

    const lines = await requireEvents(runner)
    const last = lines.at(-1)
    expect(last?.type).toBe('failed')
    expect(last?.error).toContain('exploder exploded')
    expect(last?.runId).toBe(runner.getRunId())
    expect(lines.filter((e) => e.type === 'done')).toHaveLength(0)
  })

  it('appends paused and resumed lines around a pause', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: 'a', meta: {} })

    let arrived = false
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const piper: Pipeline = {
      id: 'events-pause',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'events-source://in' } },
        {
          type: 'tap',
          config: {
            name: 'gate',
            fn: async () => {
              arrived = true
              await gate
            },
          },
        },
        { type: 'target', config: { uri: 'events-target://out' } },
      ],
    }

    const runner = new Runner(piper, context())
    const running = runner.start()
    while (!arrived) await new Promise((resolve) => setTimeout(resolve, 10))

    await runner.pause()
    await runner.unpause()
    release()
    await running

    const types = (await requireEvents(runner)).map((e) => e.type)
    expect(types).toContain('paused')
    expect(types).toContain('resumed')
    expect(types.indexOf('paused')).toBeLessThan(types.indexOf('resumed'))
    expect(types.at(-1)).toBe('done')
  })

  it('appends a resumed line when a run is resumed from disk', async () => {
    sourceItems.push({ id: 'ex-test', variables: [], item: 'a', meta: {} })

    let explode = true
    const flakyTool: Tool<unknown, unknown> = {
      name: 'flaky',
      version: '1.0.0',
      mdDescription: 'Throws on the first pass, echoes afterwards.',
      invoke: async (env) => {
        if (explode) throw new Error('flaky exploded')
        return env
      },
    }

    const runner = new Runner(pipeline('events-resume', flakyTool), context())
    await expect(runner.start()).rejects.toThrow('flaky exploded')

    const runId = runner.getRunId()
    if (!runId) throw new Error('run did not mint a runId')

    // resume() continues the same run, so its lines are appended to the same log.
    const before = (await requireEvents(runner)).length
    explode = false
    await new Runner(pipeline('events-resume', flakyTool), context()).resume(runId)

    const appended = (await requireEvents(runner)).slice(before).map((e) => e.type)
    expect(appended[0]).toBe('resumed')
    expect(appended.at(-1)).toBe('done')
  })
})

async function requireEvents(runner: Runner): Promise<RunEvent[]> {
  const runId = runner.getRunId()
  if (!runId) throw new Error('runner has no run id')
  return events(runId)
}
