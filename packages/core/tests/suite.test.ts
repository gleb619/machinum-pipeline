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

import { defineSuite, isPipelineSuite } from '../src/suite.js'

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

describe('defineSuite', () => {
  it('defaults id and keeps a defensive copy of pipelines', () => {
    const first = makePipeline('first')
    const second = makePipeline('second')
    const declared = [first]
    const suite = defineSuite(declared)

    declared.push(second)

    expect(suite.kind).toBe('pipeline-suite')
    expect(suite.id).toBe('pipeline-suite')
    expect(suite.pipelines).toEqual([first])
    expect(suite.pipelines).not.toBe(declared)
  })

  it('uses a custom suite id', () => {
    const suite = defineSuite([makePipeline('one')], { id: 'basic-md-all' })

    expect(suite.id).toBe('basic-md-all')
  })

  it('rejects empty and invalid pipeline lists at definition time', () => {
    expect(() => defineSuite([])).toThrow(/non-empty array/)
    expect(() => defineSuite(null as unknown as Pipeline[])).toThrow(/non-empty array/)
    expect(() => defineSuite(['not-a-pipeline' as unknown as Pipeline])).toThrow(/pipelines\[0\]/)
    expect(() => defineSuite([{} as Pipeline])).toThrow(/pipelines\[0\]/)
    expect(() => defineSuite([{ ...makePipeline('bad'), id: 42 } as unknown as Pipeline])).toThrow(
      /pipelines\[0\]/,
    )
  })
})

describe('isPipelineSuite', () => {
  it('accepts a suite created by defineSuite', () => {
    expect(isPipelineSuite(defineSuite([makePipeline('one')]))).toBe(true)
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

describe('PipelineSuite.run', () => {
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

    const suite = defineSuite([makePipeline('one'), makePipeline('two')])
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
    const suite = defineSuite([pipeline])
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

    const suite = defineSuite([makePipeline('one'), makePipeline('two')])

    await expect(suite.run(makeContext())).rejects.toBe(failure)
    expect(events).toEqual(['construct:one', 'start:one'])
  })
})
