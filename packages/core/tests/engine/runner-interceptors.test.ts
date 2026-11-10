import { beforeEach, describe, expect, it, vi } from 'vitest'
import { definePipeline } from '../../src/dsl.js'
import { Runner } from '../../src/engine/runner.js'
import type {
  Envelope,
  Exchange,
  GlobalContext,
  Pipeline,
  RunStateData,
  Tool,
  ToolContext,
} from '../../src/types.js'
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

registry.registerSource('interceptor-source', (_uri) => ({
  uri: _uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of sourceItems) yield env
  },
  async *resume() {
    for (const env of sourceItems) yield env
  },
}))

registry.registerTarget('interceptor-target', (_uri) => ({
  uri: _uri.raw,
  async open() {
    targetItems.length = 0
  },
  async write(env: Envelope<unknown>) {
    targetItems.push(env)
  },
  async close() {},
}))

const fastRetry = { max: 0, backoffMs: 0, strategy: 'fixed' as const }

const globalContext: GlobalContext = {
  project: { name: 'test', root: '/tmp/test-interceptors' },
  defaults: {
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' as const },
    onError: 'fail-run' as const,
    concurrency: 1,
  },
  settings: {},
  env: {},
}

/** Tool that pushes '<name>:tool' and appends its name to the item's `seen` list. */
function markingTool(name: string): Tool<{ seen: string[] }, { seen: string[] }> {
  return {
    name,
    version: '1.0.0',
    mdDescription: `Marks the item with '${name}'.`,
    invoke: async (env) => {
      events.push(`${name}:tool`)
      return { ...env, item: { seen: [...env.item.seen, name] } }
    },
  }
}

/** Shared order log, reset per test. */
let events: string[] = []

function item(seen: string[] = []): Envelope<unknown> {
  return { id: 'ex-1', item: { seen }, meta: {}, variables: [] }
}

function runPipeline(pipeline: Pipeline): Promise<unknown> {
  const runner = new Runner(pipeline, globalContext)
  return runner.start()
}

beforeEach(() => {
  events = []
  sourceItems.length = 0
  sourceItems.push(item())
})

describe('pipeline interceptors', () => {
  it('runs before interceptors in registration order and lets them swap the exchange', async () => {
    const seenCtx: Array<ToolContext | undefined> = []
    const pipeline = definePipeline({ id: 'p', retry: fastRetry })
      .from('interceptor-source://input')
      .before((ex, ctx) => {
        events.push('before-1')
        seenCtx.push(ctx)
        return { ...ex, item: { seen: [...(ex.item as { seen: string[] }).seen, 'b1'] } }
      })
      .before((ex) => {
        events.push('before-2')
        return { ...ex, item: { seen: [...(ex.item as { seen: string[] }).seen, 'b2'] } }
      })
      .use(markingTool('tool'))
      .to('interceptor-target://output')

    await runPipeline(pipeline)

    expect(events).toEqual(['before-1', 'before-2', 'tool:tool'])
    expect((targetItems[0]?.item as { seen: string[] }).seen).toEqual(['b1', 'b2', 'tool'])
    // Same ToolContext family the tool receives (step-scoped run context).
    expect(seenCtx[0]?.run.runId).toBeDefined()
  })

  it('runs after interceptors in registration order on the tool output', async () => {
    const pipeline = definePipeline({ id: 'p', retry: fastRetry })
      .from('interceptor-source://input')
      .use(markingTool('tool'))
      .after((ex) => {
        events.push('after-1')
        return { ...ex, item: { seen: [...(ex.item as { seen: string[] }).seen, 'a1'] } }
      })
      .after((ex) => {
        events.push('after-2')
        return { ...ex, item: { seen: [...(ex.item as { seen: string[] }).seen, 'a2'] } }
      })
      .to('interceptor-target://output')

    await runPipeline(pipeline)

    expect(events).toEqual(['tool:tool', 'after-1', 'after-2'])
    expect((targetItems[0]?.item as { seen: string[] }).seen).toEqual(['tool', 'a1', 'a2'])
  })

  it('nests around interceptors like onion middleware, first registered outermost', async () => {
    const pipeline = definePipeline({ id: 'p', retry: fastRetry })
      .from('interceptor-source://input')
      .around(async (ex, _ctx, next) => {
        events.push('around-1:in')
        const out = await next(ex)
        events.push('around-1:out')
        return out
      })
      .around(async (ex, _ctx, next) => {
        events.push('around-2:in')
        const out = await next(ex)
        events.push('around-2:out')
        return out
      })
      .use(markingTool('tool'))
      .to('interceptor-target://output')

    await runPipeline(pipeline)

    expect(events).toEqual([
      'around-1:in',
      'around-2:in',
      'tool:tool',
      'around-2:out',
      'around-1:out',
    ])
  })

  it('an around interceptor can swap the exchange and catch errors', async () => {
    const failing: Tool<unknown, unknown> = {
      name: 'failing',
      version: '1.0.0',
      mdDescription: 'Always throws.',
      invoke: async () => {
        throw new Error('boom')
      },
    }
    const pipeline = definePipeline({ id: 'p', retry: fastRetry, onError: 'skip-item' })
      .from('interceptor-source://input')
      .around(async (ex, _ctx, next) => {
        try {
          return await next(ex)
        } catch {
          events.push('around:caught')
          return { ...ex, item: { seen: ['recovered'] } } as Exchange<unknown>
        }
      })
      .use(failing)
      .to('interceptor-target://output')

    await runPipeline(pipeline)

    expect(events).toEqual(['around:caught'])
    expect((targetItems[0]?.item as { seen: string[] }).seen).toEqual(['recovered'])
  })

  it('a throwing before interceptor skips the tool and fails the run under fail-run', async () => {
    const tool = markingTool('tool')
    const invokeSpy = vi.spyOn(tool, 'invoke')
    const pipeline = definePipeline({ id: 'p', retry: fastRetry })
      .from('interceptor-source://input')
      .before(() => {
        events.push('before')
        throw new Error('before failed')
      })
      .use(tool)
      .after(() => {
        events.push('after')
      })
      .to('interceptor-target://output')

    await expect(runPipeline(pipeline)).rejects.toThrow('before failed')
    expect(events).toEqual(['before'])
    expect(invokeSpy).not.toHaveBeenCalled()
  })

  it('a throwing before interceptor follows skip-item: item dropped, after not called, run done', async () => {
    const tool = markingTool('tool')
    const invokeSpy = vi.spyOn(tool, 'invoke')
    const pipeline = definePipeline({ id: 'p', retry: fastRetry, onError: 'skip-item' })
      .from('interceptor-source://input')
      .before(() => {
        throw new Error('before failed')
      })
      .use(tool)
      .after(() => {
        events.push('after')
      })
      .to('interceptor-target://output')

    await runPipeline(pipeline)

    expect(invokeSpy).not.toHaveBeenCalled()
    expect(events).not.toContain('after')
    expect(targetItems).toEqual([])
    expect(persistedStates.at(-1)?.state).toBe('done')
  })

  it('does not call after interceptors when the tool fails', async () => {
    const failing: Tool<unknown, unknown> = {
      name: 'failing',
      version: '1.0.0',
      mdDescription: 'Always throws.',
      invoke: async () => {
        throw new Error('tool boom')
      },
    }
    const pipeline = definePipeline({ id: 'p', retry: fastRetry, onError: 'skip-item' })
      .from('interceptor-source://input')
      .use(failing)
      .after(() => {
        events.push('after')
      })
      .to('interceptor-target://output')

    await runPipeline(pipeline)

    expect(events).toEqual([])
    expect(targetItems).toEqual([])
  })

  it('fork children inherit parent interceptors', async () => {
    const child = definePipeline({ id: 'child' })
      .use(markingTool('child-tool'))
      .to('interceptor-target://output')

    const pipeline = definePipeline({ id: 'p', retry: fastRetry })
      .from('interceptor-source://input')
      .before(() => {
        events.push('parent-before')
      })
      .fork(child)
      .to('interceptor-target://output')

    await runPipeline(pipeline)

    expect(events).toEqual(['parent-before', 'child-tool:tool'])
  })

  it('a child pipeline with its own interceptors overrides the parent chain', async () => {
    const child = definePipeline({ id: 'child' })
      .before(() => {
        events.push('child-before')
      })
      .use(markingTool('child-tool'))

    const pipeline = definePipeline({ id: 'p', retry: fastRetry })
      .from('interceptor-source://input')
      .before(() => {
        events.push('parent-before')
      })
      .fork(child)
      .to('interceptor-target://output')

    await runPipeline(pipeline)

    expect(events).toEqual(['child-before', 'child-tool:tool'])
  })

  it('inline subflow children inherit parent interceptors', async () => {
    const child = definePipeline({ id: 'child' }).use(markingTool('child-tool'))

    const pipeline = definePipeline({ id: 'p', retry: fastRetry })
      .from('interceptor-source://input')
      .before(() => {
        events.push('parent-before')
      })
      .subflow(child)
      .to('interceptor-target://output')

    await runPipeline(pipeline)

    expect(events).toEqual(['parent-before', 'child-tool:tool'])
  })

  it('leaves a pipeline without interceptors unchanged', async () => {
    const pipeline = definePipeline({ id: 'p', retry: fastRetry })
      .from('interceptor-source://input')
      .use(markingTool('tool'))
      .to('interceptor-target://output')

    await runPipeline(pipeline)

    expect(events).toEqual(['tool:tool'])
    expect((targetItems[0]?.item as { seen: string[] }).seen).toEqual(['tool'])
    expect(persistedStates.at(-1)?.state).toBe('done')
  })
})
