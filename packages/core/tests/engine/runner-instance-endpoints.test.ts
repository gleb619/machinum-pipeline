import { describe, expect, it, vi } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { definePipeline } from '../../src/dsl.js'
import { Runner } from '../../src/engine/runner.js'
import type { Envelope, Source, Target } from '../../src/types.js'
import { registry } from '../../src/uri.js'

vi.mock('../../src/store.js', () => ({
  Store: class {
    ensureDir = vi.fn().mockResolvedValue(undefined)
    writeJson = vi.fn().mockResolvedValue(undefined)
    readJson = vi.fn().mockResolvedValue({ state: 'done', checkpoint: { stepId: 'root' } })
    append = vi.fn().mockResolvedValue(undefined)
  },
}))

const globalContext: GlobalContext = {
  project: { name: 'test', root: '/tmp/test-instance-endpoints' },
  defaults: {
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' as const },
    onError: 'fail-run' as const,
    concurrency: 1,
  },
  settings: {},
  env: {},
}

/** Source instance on a scheme that is NOT registered — the Runner must not resolve it by URI. */
function customSource(items: string[]): Source<string> {
  return {
    uri: 'custom-source://input',
    lifestyle: 'long-lived',
    async *start() {
      for (const item of items) yield { item, meta: {} }
    },
  }
}

/** Target instance on a scheme that is NOT registered — the Runner must not resolve it by URI. */
function customTarget(): Target<string> & { written: string[]; calls: string[] } {
  const target = {
    uri: 'custom-target://output',
    written: [] as string[],
    calls: [] as string[],
    async open() {
      target.calls.push('open')
    },
    async write(env: Envelope<string>) {
      target.calls.push('write')
      target.written.push(env.item)
    },
    async close() {
      target.calls.push('close')
    },
  }
  return target
}

describe('runner instance endpoints', () => {
  it('runs custom source/target instances whose schemes are not registered', async () => {
    // Precondition: the registry cannot resolve these URIs — only the instances can.
    expect(registry.hasSource('custom-source')).toBe(false)
    expect(registry.hasTarget('custom-target')).toBe(false)

    const source = customSource(['a', 'b'])
    const target = customTarget()

    const pipeline = definePipeline({ id: 'instance-endpoints' }).from(source).to(target)
    await new Runner(pipeline, globalContext).start()

    expect(target.written).toEqual(['a', 'b'])
    expect(target.calls).toEqual(['open', 'write', 'write', 'close'])
  })

  it('keeps the instances in the step config instead of flattening them to their uri', () => {
    const source = customSource(['a'])
    const target = customTarget()

    const pipeline = definePipeline({ id: 'instance-endpoints-config' }).from(source).to(target)

    const sourceConfig = pipeline.steps[0]?.config ?? {}
    const targetConfig = pipeline.steps[1]?.config ?? {}
    expect(sourceConfig.uri).toBe('custom-source://input')
    expect(targetConfig.uri).toBe('custom-target://output')
    // The instance itself travels with the step — key-agnostic on purpose.
    expect(Object.values(sourceConfig)).toContain(source)
    expect(Object.values(targetConfig)).toContain(target)
  })

  it('still resolves URI strings through the registry', async () => {
    registry.registerSource<string>('instance-test-src', (uri) => ({
      uri: uri.raw,
      lifestyle: 'long-lived',
      async *start() {
        yield { item: 'x', meta: {} }
      },
    }))
    registry.registerTarget<string>('instance-test-tgt', (uri) => ({
      uri: uri.raw,
      async open() {},
      async write() {},
      async close() {},
    }))

    const pipeline = definePipeline({ id: 'instance-endpoints-uri' })
      .from('instance-test-src://input')
      .to('instance-test-tgt://output')

    // The URI path stores only the uri — no instance is carried along.
    expect(Object.values(pipeline.steps[0]?.config ?? {})).toHaveLength(1)
    expect(Object.values(pipeline.steps[1]?.config ?? {})).toHaveLength(1)

    await new Runner(pipeline, globalContext).start()
  })
})
