import { beforeEach, describe, expect, it, vi } from 'vitest'
import { definePipeline, defineTool } from '../src/dsl.js'
import { Runner } from '../src/engine/runner.js'
import { withItem, withMeta } from '../src/exchange.js'
import type { Envelope, GlobalContext, Pipeline, Tool } from '../src/types.js'
import { registry } from '../src/uri.js'

vi.mock('../src/store.js', () => ({
  Store: class {
    ensureDir = vi.fn().mockResolvedValue(undefined)
    writeJson = vi.fn().mockResolvedValue(undefined)
    readJson = vi.fn().mockResolvedValue({ state: 'done', checkpoint: { stepId: 'root' } })
    append = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('../src/engine/cache.js', () => ({
  Cache: class {
    computeKey = vi.fn().mockReturnValue('key')
    has = vi.fn().mockResolvedValue(false)
    get = vi.fn().mockResolvedValue(undefined)
    set = vi.fn().mockResolvedValue(undefined)
  },
}))

const sourceItems: Array<Envelope<unknown>> = []
const targetItems: Array<Envelope<unknown>> = []

registry.registerSource('params-source', (uri) => ({
  uri: uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of sourceItems) yield env
  },
  async *resume() {
    for (const env of sourceItems) yield env
  },
}))

registry.registerTarget('params-target', (uri) => ({
  uri: uri.raw,
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
  project: { name: 'test', root: '/tmp/test-use-params' },
  defaults: {
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' as const },
    onError: 'fail-run' as const,
    concurrency: 1,
  },
  settings: {},
  env: {},
}

let toolEnvMetas: Array<Record<string, unknown>> = []

/** Tool that echoes its input item, recording the meta it received. */
function echoTool(): Tool<string, string> {
  return {
    name: 'params-echo',
    version: '1.0.0',
    mdDescription: 'Echoes the item, recording the incoming meta.',
    invoke: async (env) => {
      toolEnvMetas.push(env.meta)
      return withItem(env, `echo:${env.item}`)
    },
  }
}

function runPipeline(pipeline: Pipeline): Promise<unknown> {
  const runner = new Runner(pipeline, globalContext)
  return runner.start()
}

beforeEach(() => {
  toolEnvMetas = []
  targetItems.length = 0
  sourceItems.length = 0
  sourceItems.push({ id: 'ex-1', item: 'hello', meta: {}, variables: [] })
})

describe('.use(tool, paramsFn)', () => {
  it('transforms the incoming exchange before the tool invoke and the meta lands on the output', async () => {
    const pipeline = definePipeline({ id: 'p', retry: fastRetry })
      .from('params-source://input')
      .use(echoTool(), (env) => withMeta(env, { chapter: '7-commas' }))
      .to('params-target://output')

    await runPipeline(pipeline)

    expect(toolEnvMetas[0]?.chapter).toBe('7-commas')
    expect(targetItems[0]?.meta.chapter).toBe('7-commas')
    expect(targetItems[0]?.item).toBe('echo:hello')
  })

  it('a params fn returning void keeps the incoming exchange', async () => {
    const pipeline = definePipeline({ id: 'p', retry: fastRetry })
      .from('params-source://input')
      .use(echoTool(), () => undefined)
      .to('params-target://output')

    await runPipeline(pipeline)

    expect(toolEnvMetas[0]).toEqual({})
    expect(targetItems[0]?.item).toBe('echo:hello')
  })

  it('a throwing params fn follows the step retry policy: retried, tool never invoked, run fails', async () => {
    const tool = echoTool()
    const invokeSpy = vi.spyOn(tool, 'invoke')
    let attempts = 0
    const pipeline = definePipeline({
      id: 'p',
      retry: { max: 2, backoffMs: 0, strategy: 'fixed' },
      onError: 'fail-run',
    })
      .from('params-source://input')
      .use(tool, () => {
        attempts += 1
        throw new Error('params failed')
      })
      .to('params-target://output')

    await expect(runPipeline(pipeline)).rejects.toThrow('params failed')

    expect(attempts).toBe(3)
    expect(invokeSpy).not.toHaveBeenCalled()
    expect(targetItems).toEqual([])
  })
})
