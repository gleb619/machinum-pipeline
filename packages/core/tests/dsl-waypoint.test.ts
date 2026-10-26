import { describe, expect, it, vi } from 'vitest'
import type { SourceContext, TargetContext } from '../src/contexts.js'
import { definePipeline, defineWaypoint } from '../src/dsl.js'
import type { Envelope, Lifecycle, Source, Target } from '../src/index.js'
import { registry } from '../src/uri.js'

// Minimal stand-in contexts — the fake sources/targets below never read them.
const srcCtx = {} as SourceContext
const tgtCtx = {} as TargetContext

/** Fake inner Source yielding a canned set of envelopes. */
function mockSource<T>(
  envelopes: Envelope<T>[],
  lifestyle: Lifecycle = 'long-lived',
  resumeEnvelopes?: Envelope<T>[],
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
  written: Envelope<T>[]
  calls: string[]
} {
  const t: Target<T> & { written: Envelope<T>[]; calls: string[] } = {
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

async function collect<T>(src: Source<T>, useResume = false): Promise<Envelope<T>[]> {
  const out: Envelope<T>[] = []
  const iter = useResume ? src.resume?.(srcCtx, 0) : src.start(srcCtx)
  if (!iter) throw new Error('resume missing')
  for await (const env of iter) out.push(env)
  return out
}

// URI-string fixtures: one source scheme (yields a..c), one target scheme (records writes).
const uriTargetWritten: Envelope<string>[] = []
registry.registerSource<string>('jsonl', () => ({
  uri: 'jsonl://./in.jsonl',
  lifestyle: 'resumable',
  async *start() {
    yield { item: 'a', meta: {} }
    yield { item: 'b', meta: {} }
    yield { item: 'c', meta: {} }
  },
  async *resume(_ctx, cursor) {
    yield { item: 'a', meta: {} }
    yield { item: 'b', meta: {} }
    yield { item: 'c', meta: {} }
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
    await wrapper.write({ item: -1, meta: {} }, tgtCtx)
    await wrapper.write({ item: 1, meta: {} }, tgtCtx)
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
    await wrapper.write({ item: 1, meta: {} }, tgtCtx)
    await wrapper.close(tgtCtx)

    expect(order).toEqual(['onOpen', 'onWrite', 'onClose'])
    expect(inner.calls).toEqual(['open', 'write', 'close'])
  })

  it('T002-17: checkpoint is forwarded only when the inner target implements it', async () => {
    const withCp = mockTarget<number>({ checkpoint: true })
    const wrapperWith = defineWaypoint<number>(withCp, {})
    expect(typeof wrapperWith.checkpoint).toBe('function')
    await wrapperWith.open(tgtCtx)
    await wrapperWith.write({ item: 1, meta: {} }, tgtCtx)
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
    const src = defineWaypoint<number>(mockSource([{ item: 1, meta: {} }]), {
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
    await expect(tgt.write({ item: 1, meta: {} }, tgtCtx)).rejects.toThrow('onWrite boom')
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
