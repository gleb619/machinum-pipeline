import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalContext } from '../src/contexts.js'
import type { Pipeline, RunnerOptions } from '../src/types.js'

const mocks = vi.hoisted(() => ({
  start: vi.fn<() => Promise<void>>(),
  Runner:
    vi.fn<
      (
        pipeline: Pipeline,
        globalContext: GlobalContext,
        options?: RunnerOptions,
      ) => { start: () => Promise<void> }
    >(),
  loadGlobalContext: vi.fn<(projectRoot: string) => Promise<GlobalContext>>(),
}))

vi.mock('../src/engine/runner.js', () => ({ Runner: mocks.Runner }))
vi.mock('../src/config.js', () => ({ loadGlobalContext: mocks.loadGlobalContext }))

import { defineProcess } from '../src/dsl.js'
import { isPipeline, isPipelineSuite } from '../src/suite.js'

function makePipeline(id: string): Pipeline {
  return {
    id,
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
    onError: 'fail-run',
    steps: [],
  }
}

function makeContext(root = '/tmp/suite-test'): GlobalContext {
  return {
    project: { name: 'suite-test', root },
    defaults: {
      retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
      onError: 'fail-run',
      concurrency: 1,
    },
    settings: {},
    env: {},
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.start.mockResolvedValue(undefined)
  mocks.Runner.mockImplementation(() => ({ start: mocks.start }))
  mocks.loadGlobalContext.mockResolvedValue(makeContext())
})

describe('defineProcess suite form', () => {
  it('defaults id and keeps a defensive copy of pipelines', () => {
    const first = makePipeline('first')
    const second = makePipeline('second')
    const declared = [first]
    const suite = defineProcess(declared)

    declared.push(second)

    expect(suite.kind).toBe('pipeline-suite')
    expect(suite.id).toBe('pipeline-suite')
    expect(suite.pipelines).toEqual([first])
    expect(suite.pipelines).not.toBe(declared)
  })

  it('uses a custom suite id', () => {
    const suite = defineProcess([makePipeline('one')], { id: 'basic-md-all' })

    expect(suite.id).toBe('basic-md-all')
  })

  it('rejects empty and invalid pipeline lists at definition time', () => {
    expect(() => defineProcess([])).toThrow(/non-empty array/)
    expect(() => defineProcess(null as unknown as Pipeline[])).toThrow(/non-empty array/)
    expect(() => defineProcess(['not-a-pipeline' as unknown as Pipeline])).toThrow(/pipelines\[0\]/)
    expect(() => defineProcess([{} as Pipeline])).toThrow(/pipelines\[0\]/)
    expect(() =>
      defineProcess([{ ...makePipeline('bad'), id: 42 } as unknown as Pipeline]),
    ).toThrow(/pipelines\[0\]/)
  })
})

describe('isPipelineSuite', () => {
  it('accepts a suite created by defineProcess([...])', () => {
    expect(isPipelineSuite(defineProcess([makePipeline('one')]))).toBe(true)
  })

  it('rejects a setup-only defineProcess() builder', () => {
    expect(isPipelineSuite(defineProcess())).toBe(false)
  })

  it('rejects null and objects that do not match the suite shape', () => {
    expect(isPipelineSuite(null)).toBe(false)
    expect(isPipelineSuite({})).toBe(false)
    expect(isPipelineSuite({ kind: 'other', id: 'suite', pipelines: [], run: () => {} })).toBe(
      false,
    )
    expect(
      isPipelineSuite({ kind: 'pipeline-suite', id: 'suite', pipelines: [], run: 'nope' }),
    ).toBe(false)
  })
})

describe('suite run', () => {
  it('constructs and starts one Runner per pipeline in order with the supplied context', async () => {
    const ctx = makeContext('/tmp/given')
    const options: RunnerOptions = { pipelineFile: 'pipelines/all.ts' }
    const events: string[] = []

    mocks.Runner.mockImplementation((pipeline, globalContext, runnerOptions) => {
      events.push(`construct:${pipeline.id}`)
      expect(globalContext).toBe(ctx)
      expect(runnerOptions).toBe(options)
      return {
        start: async () => {
          events.push(`start:${pipeline.id}`)
          await Promise.resolve()
          events.push(`end:${pipeline.id}`)
        },
      }
    })

    const suite = defineProcess([makePipeline('one'), makePipeline('two')])
    await suite.run(ctx, options)

    expect(events).toEqual([
      'construct:one',
      'start:one',
      'end:one',
      'construct:two',
      'start:two',
      'end:two',
    ])
    expect(mocks.loadGlobalContext).not.toHaveBeenCalled()
  })

  it('loads the global context from process.cwd when none is supplied', async () => {
    const ctx = makeContext('/tmp/loaded')
    const pipeline = makePipeline('one')
    const suite = defineProcess([pipeline])
    mocks.loadGlobalContext.mockResolvedValue(ctx)

    await suite.run()

    expect(mocks.loadGlobalContext).toHaveBeenCalledWith(process.cwd())
    expect(mocks.Runner).toHaveBeenCalledWith(pipeline, ctx, undefined)
  })

  it('stops on the first failure and propagates it', async () => {
    const failure = new Error('pipeline failed')
    const events: string[] = []

    mocks.Runner.mockImplementation((pipeline) => {
      events.push(`construct:${pipeline.id}`)
      return {
        start: async () => {
          events.push(`start:${pipeline.id}`)
          if (pipeline.id === 'one') throw failure
        },
      }
    })

    const suite = defineProcess([makePipeline('one'), makePipeline('two')])

    await expect(suite.run(makeContext())).rejects.toBe(failure)
    expect(events).toEqual(['construct:one', 'start:one'])
  })

  it('throws when run() is called on a setup-only builder', async () => {
    await expect(defineProcess().run(makeContext())).rejects.toThrow(/no pipelines/)
  })
})

describe('suite modes', () => {
  it('defaults to sync', () => {
    expect(defineProcess([makePipeline('one')]).mode).toBe('sync')
  })

  it('accepts an explicit mode', () => {
    expect(defineProcess([makePipeline('one')], { mode: 'parallel' }).mode).toBe('parallel')
  })

  it('parallel(true|false) returns new suites without mutating the original', () => {
    const one = makePipeline('one')
    const two = makePipeline('two')
    const sync = defineProcess([one, two], { id: 'all' })

    const parallel = sync.parallel(true)
    const backToSync = parallel.parallel(false)

    expect(sync.mode).toBe('sync')
    expect(parallel.mode).toBe('parallel')
    expect(backToSync.mode).toBe('sync')
    expect(parallel).not.toBe(sync)
    expect(backToSync).not.toBe(parallel)
    for (const suite of [sync, parallel, backToSync]) {
      expect(suite.id).toBe('all')
      expect(suite.pipelines).toEqual([one, two])
    }
  })

  it('starts every pipeline before resolving any runner in parallel mode', async () => {
    const started: string[] = []
    const resolvers = new Map<string, () => void>()

    mocks.Runner.mockImplementation((pipeline) => ({
      start: () =>
        new Promise<void>((resolve) => {
          started.push(pipeline.id)
          resolvers.set(pipeline.id, resolve)
        }),
    }))

    const suite = defineProcess([makePipeline('one'), makePipeline('two')]).parallel(true)
    const running = suite.run(makeContext())

    expect(started).toEqual(['one', 'two'])
    resolvers.get('one')?.()
    resolvers.get('two')?.()
    await running
  })

  it('reports each runner through onRunner once, with its pipeline', async () => {
    const runners: unknown[] = []
    mocks.Runner.mockImplementation(() => {
      const runner = { start: async () => undefined }
      runners.push(runner)
      return runner
    })

    const suite = defineProcess([makePipeline('one'), makePipeline('two')])
    const seen: string[] = []

    await suite.run(makeContext(), {
      onRunner: (runner, pipeline) => {
        seen.push(`${pipeline.id}:${runners.includes(runner)}`)
      },
    })

    expect(seen).toEqual(['one:true', 'two:true'])
  })
})

describe('isPipeline', () => {
  it('accepts a pipeline-shaped object', () => {
    expect(isPipeline(makePipeline('one'))).toBe(true)
  })

  it('rejects values without a string id or steps array', () => {
    expect(isPipeline(null)).toBe(false)
    expect(isPipeline('pipeline')).toBe(false)
    expect(isPipeline({ id: 'one' })).toBe(false)
    expect(isPipeline({ steps: [] })).toBe(false)
    expect(isPipeline({ id: 'one', steps: 'nope' })).toBe(false)
  })
})
