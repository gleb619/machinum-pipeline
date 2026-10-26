import { describe, expect, it, vi } from 'vitest'
import type { GlobalContext, SourceContext, TargetContext } from '../src/contexts.js'
import { definePipeline, defineWaypoint } from '../src/dsl.js'
import { Runner } from '../src/engine/runner.js'
import {
  type ExchangeInput,
  type Lifecycle,
  type Source,
  type Target,
  createExchange,
} from '../src/index.js'
import { registry } from '../src/uri.js'

// Runner-level tests persist nothing: stub the Store like tests/engine/runner.test.ts does.
vi.mock('../src/store.js', () => ({
  Store: class {
    ensureDir = vi.fn().mockResolvedValue(undefined)
    writeJson = vi.fn().mockResolvedValue(undefined)
    readJson = vi.fn().mockResolvedValue({ state: 'done', checkpoint: { stepId: 'root' } })
    append = vi.fn().mockResolvedValue(undefined)
  },
}))

// Minimal stand-in contexts — the fake sources/targets below never read them.
const srcCtx = {} as SourceContext
const tgtCtx = {} as TargetContext

/** Fake inner Source yielding a canned set of envelopes. */
function mockSource<T>(
  envelopes: ExchangeInput<T>[],
  lifestyle: Lifecycle = 'long-lived',
  resumeEnvelopes?: ExchangeInput<T>[],
): Source<T> {
  return {
    uri: 'mock://source',
    lifestyle,
    async *start() {
      yield* envelopes
    },
    ...(resumeEnvelopes
      ? {
          async *resume(_ctx: SourceContext, cursor: unknown) {
            yield* resumeEnvelopes.slice(Number(cursor))
          },
        }
      : {}),
  }
}

/** Fake inner Target recording writes and lifecycle calls. */
function mockTarget<T>(opts: { checkpoint?: boolean } = {}): Target<T> & {
  written: ExchangeInput<T>[]
  calls: string[]
} {
  const t: Target<T> & { written: ExchangeInput<T>[]; calls: string[] } = {
    uri: 'mock://target',
    written: [],
    calls: [],
    async open() {
      t.calls.push('open')
    },
    async write(env) {
      t.calls.push('write')
      t.written.push(env)
    },
    async close() {
      t.calls.push('close')
    },
  }
  if (opts.checkpoint) {
    t.checkpoint = async () => t.written.length
  }
  return t
}

async function collect<T>(src: Source<T>, useResume = false): Promise<ExchangeInput<T>[]> {
  const out: ExchangeInput<T>[] = []
  const iter = useResume ? src.resume?.(srcCtx, 0) : src.start(srcCtx)
  if (!iter) throw new Error('resume missing')
  for await (const env of iter) out.push(env)
  return out
}

// URI-string fixtures: one source scheme (yields a..c), one target scheme (records writes).
const uriTargetWritten: ExchangeInput<string>[] = []
registry.registerSource<string>('jsonl', () => ({
  uri: 'jsonl://./in.jsonl',
  lifestyle: 'resumable',
  async *start() {
    yield createExchange('a')
    yield createExchange('b')
    yield createExchange('c')
  },
  async *resume(_ctx, cursor) {
    yield createExchange('a')
    yield createExchange('b')
    yield createExchange('c')
    void cursor
  },
}))
registry.registerTarget<string>('jsonlout', () => ({
  uri: 'jsonlout://./out.jsonl',
  async open() {},
  async write(env) {
    uriTargetWritten.push(env)
  },
  async close() {},
}))

function makeGlobalContext(): GlobalContext {
  return {
    project: { name: 'test', root: '/tmp' },
    defaults: {
      retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
      onError: 'fail-run',
      concurrency: 1,
    },
    settings: {},
    env: {},
  }
}

describe('defineWaypoint through the Runner', () => {
  it('T002-22: wrapper instances reach the run — hooks fire and the filter applies', async () => {
    const innerSrc = mockSource<number>([1, 2, 3].map((item) => ({ item, meta: {} })))
    const innerTgt = mockTarget<number>()
    const events: string[] = []

    // Wrapped endpoints passed as INSTANCES must be used by the Runner, not re-resolved from
    // the URI (regression: .from()/.to() used to flatten instances to their uri string).
    const src = defineWaypoint<number>(innerSrc, {
      onStart: () => {
        events.push('source:start')
      },
      filter: (env) => env.item !== 2,
      onItem: (env) => {
        events.push(`source:item:${env.item}`)
      },
    })
    const tgt = defineWaypoint<number>(innerTgt, {
      onOpen: () => {
        events.push('target:open')
      },
      onWrite: (env) => {
        events.push(`target:write:${env.item}`)
      },
      onClose: () => {
        events.push('target:close')
      },
    })

    const pipeline = definePipeline({ id: 'wp-run' }).from(src).to(tgt)
    await new Runner(pipeline, makeGlobalContext()).start()

    expect(innerTgt.written.map((e) => e.item)).toEqual([1, 3])
    expect(innerTgt.calls).toEqual(['open', 'write', 'write', 'close'])
    // The runner opens the target before it starts streaming the source — assert the multiset,
    // the source events preceding their writes, and close being last.
    expect([...events].sort()).toEqual(
      [
        'source:start',
        'source:item:1',
        'source:item:3',
        'target:open',
        'target:write:1',
        'target:write:3',
        'target:close',
      ].sort(),
    )
    expect(events.indexOf('source:item:1')).toBeLessThan(events.indexOf('target:write:1'))
    expect(events.indexOf('source:item:3')).toBeLessThan(events.indexOf('target:write:3'))
    expect(events.at(-1)).toBe('target:close')
  })
})

describe('defineWaypoint', () => {
  it('T002-13: source wrapper filters envelopes and calls onItem only for kept ones', async () => {
    const inner = mockSource<number>([1, 2, 3, 4].map((item) => ({ item, meta: {} })))
    const onItem = vi.fn()
    const wrapper = defineWaypoint<number>(inner, {
      filter: (env) => env.item % 2 === 0,
      onItem,
    })

    const out = await collect(wrapper)
    expect(out.map((e) => e.item)).toEqual([2, 4])
    expect(onItem.mock.calls.map(([env]) => env.item)).toEqual([2, 4])
    expect(wrapper.uri).toBe('mock://source')
    expect(wrapper.lifestyle).toBe('long-lived')
  })

  it('T002-14: source wrapper from URI string resolves through the registry', async () => {
    const wrapper = defineWaypoint<string>('jsonl://./in.jsonl', {
      filter: (env) => env.item !== 'b',
    })

    const out = await collect(wrapper)
    expect(out.map((e) => e.item)).toEqual(['a', 'c'])
    expect(wrapper.uri).toBe('jsonl://./in.jsonl')
    expect(wrapper.lifestyle).toBe('resumable')
  })

  it('T002-15: target wrapper filter skips the inner write', async () => {
    const inner = mockTarget<number>()
    const wrapper = defineWaypoint<number>(inner, { filter: (env) => env.item > 0 })

    await wrapper.open(tgtCtx)
    await wrapper.write(createExchange(-1), tgtCtx)
    await wrapper.write(createExchange(1), tgtCtx)
    await wrapper.close(tgtCtx)

    expect(inner.written.map((e) => e.item)).toEqual([1])
  })

  it('T002-16: target hooks run in order inner-open → onOpen → write → onWrite → inner-close → onClose', async () => {
    const inner = mockTarget<number>()
    const order: string[] = []
    const wrapper = defineWaypoint<number>(inner, {
      onOpen: () => void order.push('onOpen'),
      onWrite: () => void order.push('onWrite'),
      onClose: () => void order.push('onClose'),
    })

    await wrapper.open(tgtCtx)
    await wrapper.write(createExchange(1), tgtCtx)
    await wrapper.close(tgtCtx)

    expect(order).toEqual(['onOpen', 'onWrite', 'onClose'])
    expect(inner.calls).toEqual(['open', 'write', 'close'])
  })

  it('T002-17: checkpoint is forwarded only when the inner target implements it', async () => {
    const withCp = mockTarget<number>({ checkpoint: true })
    const wrapperWith = defineWaypoint<number>(withCp, {})
    expect(typeof wrapperWith.checkpoint).toBe('function')
    await wrapperWith.open(tgtCtx)
    await wrapperWith.write(createExchange(1), tgtCtx)
    expect(await wrapperWith.checkpoint?.(tgtCtx)).toBe(1)

    const withoutCp = mockTarget<number>()
    const wrapperWithout = defineWaypoint<number>(withoutCp, {})
    expect(wrapperWithout.checkpoint).toBeUndefined()
  })

  it('T002-18: resume passthrough applies the same filter and onItem', async () => {
    const resumeEnvelopes = [1, 2, 3].map((item) => ({ item, meta: {} }))
    const inner = mockSource<number>([], 'resumable', resumeEnvelopes)
    const onItem = vi.fn()
    const wrapper = defineWaypoint<number>(inner, {
      filter: (env) => env.item !== 2,
      onItem,
    })

    expect(wrapper.resume).toBeDefined()
    const out = await collect(wrapper, true)
    expect(out.map((e) => e.item)).toEqual([1, 3])
    expect(onItem.mock.calls.map(([env]) => env.item)).toEqual([1, 3])
  })

  it('T002-19: wrapper omits resume when the inner source has none', () => {
    const inner = mockSource<number>([])
    const wrapper = defineWaypoint<number>(inner, {})
    expect(wrapper.resume).toBeUndefined()
  })

  it('T002-20: hook errors propagate (source filter and target onWrite)', async () => {
    const src = defineWaypoint<number>(mockSource([createExchange(1)]), {
      filter: () => {
        throw new Error('filter boom')
      },
    })
    await expect(collect(src)).rejects.toThrow('filter boom')

    const inner = mockTarget<number>()
    const tgt = defineWaypoint<number>(inner, {
      onWrite: () => {
        throw new Error('onWrite boom')
      },
    })
    await tgt.open(tgtCtx)
    await expect(tgt.write(createExchange(1), tgtCtx)).rejects.toThrow('onWrite boom')
  })

  it('T002-21: wrapper works in definePipeline().from() / .to() with the inner uri in steps', () => {
    const wrapper = defineWaypoint<string>('jsonl://./in.jsonl', {})
    // String bases resolve source-first, so a string target needs a source-free
    // scheme (or a cast) to select the Target overload.
    const outTarget = defineWaypoint<string>(
      'jsonlout://./out.jsonl',
      {},
    ) as unknown as Target<string>
    const pipeline = definePipeline({ id: 'wp-pipeline' }).from(wrapper).to(outTarget)

    expect(pipeline.steps[0]?.type).toBe('source')
    expect(pipeline.steps[0]?.config.uri).toBe('jsonl://./in.jsonl')
    expect(pipeline.steps[1]?.type).toBe('target')
    expect(pipeline.steps[1]?.config.uri).toBe('jsonlout://./out.jsonl')
  })
})
