import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BusEvent,
  type Exchange,
  type ExchangeInput,
  type GlobalContext,
  type ParsedUri,
  Runner,
  type SourceContext,
  type TargetContext,
  definePipeline,
  registry,
  subscribeEvent,
} from '@mt/core'
import { describe, expect, it } from 'vitest'
import { createEmitTarget, emitPayload } from '../../src/emit.js'
import { createEventsSource } from '../../src/events.js'

const publisherItems: unknown[] = []

registry.registerSource('emit-test-source', (uri) => ({
  uri: uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const item of publisherItems) yield { item }
  },
}))

function makeUri(raw: string): ParsedUri {
  const url = new URL(raw)
  return {
    scheme: url.protocol.slice(0, -1),
    host: url.hostname,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    fragment: url.hash.slice(1),
    raw,
  }
}

function makeEnv(overrides: Partial<Exchange<unknown>> = {}): Exchange<unknown> {
  return {
    id: 'ex-1',
    item: 'hello',
    meta: { chapter: 1 },
    variables: [],
    ...overrides,
  }
}

function uniqueChannel(label: string): string {
  return `emit-test-${label}-${randomUUID()}`
}

const ctx = {} as unknown as TargetContext

describe('emitPayload', () => {
  it('selects item, items, meta or the full envelope', () => {
    const env = makeEnv({ items: ['a', 'b'] })
    expect(emitPayload(env, 'item')).toBe('hello')
    expect(emitPayload(env, 'items')).toEqual(['a', 'b'])
    expect(emitPayload(env, 'meta')).toEqual({ chapter: 1 })
    expect(emitPayload(env, 'envelope')).toEqual({
      id: 'ex-1',
      item: 'hello',
      items: ['a', 'b'],
      meta: { chapter: 1 },
      variables: [],
    })
  })
})

describe('emit target', () => {
  it('publishes the item by default and counts the envelope', async () => {
    const channel = uniqueChannel('default')
    const received: BusEvent[] = []
    const off = subscribeEvent(channel, (event) => received.push(event))

    const target = createEmitTarget(makeUri(`emit://${channel}`))
    await target.open(ctx)
    await target.write(makeEnv(), ctx)
    await target.write(makeEnv({ id: 'ex-2', item: 'bye' }), ctx)
    expect(await target.checkpoint()).toBe(2)
    await target.close(ctx)
    off()

    expect(received.map((event) => event.payload)).toEqual(['hello', 'bye'])
    expect(received[0]?.type).toBe(channel)
  })

  const payloadCases = [
    { mode: 'items' as const, overrides: { items: ['x'] }, expected: ['x'] },
    { mode: 'meta' as const, overrides: {}, expected: { chapter: 1 } },
    {
      mode: 'envelope' as const,
      overrides: {},
      expected: { id: 'ex-1', item: 'hello', meta: { chapter: 1 }, variables: [] },
    },
  ]

  it.each(payloadCases)(
    'publishes payload=$mode from the query',
    async ({ mode, overrides, expected }) => {
      const channel = uniqueChannel(mode)
      const received: BusEvent[] = []
      const off = subscribeEvent(channel, (event) => received.push(event))

      const target = createEmitTarget(makeUri(`emit://${channel}?payload=${mode}`))
      await target.write(makeEnv(overrides), ctx)
      off()

      expect(received[0]?.payload).toEqual(expected)
    },
  )

  it('rejects an unknown payload mode at factory time', () => {
    expect(() => createEmitTarget(makeUri('emit://channel?payload=raw'))).toThrow(
      "Invalid emit:// payload 'raw'",
    )
  })

  it('rejects an empty channel', () => {
    expect(() =>
      createEmitTarget({ scheme: 'emit', raw: 'emit://', host: '', path: '', query: {} }),
    ).toThrow('emit:// requires a channel name')
  })

  it('refuses to shadow a lifecycle event type', () => {
    expect(() => createEmitTarget(makeUri('emit://done'))).toThrow('is a lifecycle event type')
  })
})

describe('emit target end to end', () => {
  it('feeds an events:// source in the same process and the stream ends with the run', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'mt-emit-waypoint-'))
    const channel = uniqueChannel('pipeline')

    publisherItems.length = 0
    publisherItems.push({ chapter: 1, title: 'One' }, { chapter: 2, title: 'Two' })

    const globalContext: GlobalContext = {
      project: { name: 'emit-test', root: projectRoot },
      defaults: {
        retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
        onError: 'fail-run',
        concurrency: 1,
      },
      settings: {},
      env: {},
    }

    const publisher = definePipeline({ id: 'emit-publisher' })
      .from('emit-test-source://in')
      .to(`emit://${channel}`)

    const runner = new Runner(publisher, globalContext)
    await runner.start()

    const source = createEventsSource<BusEvent>(makeUri(`events://${channel}`))
    const sourceCtx = {
      run: {
        runId: 'emit-subscriber',
        global: { project: { name: 'emit-test', root: projectRoot }, settings: {} },
      },
    } as unknown as SourceContext
    const iterator = source.start(sourceCtx)[Symbol.asyncIterator]()
    const events: ExchangeInput<BusEvent>[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      events.push(next.value)
    }

    expect(events).toHaveLength(2)
    expect(events.map((event) => event.item.payload)).toEqual([
      { chapter: 1, title: 'One' },
      { chapter: 2, title: 'Two' },
    ])
    expect(events[0]?.meta.eventName).toBe(channel)
  })
})
