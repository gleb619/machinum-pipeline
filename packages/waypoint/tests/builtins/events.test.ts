import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runner, createConsoleLogger, definePipeline, emitEvent, registry } from '@mt/core'
import type {
  BusEvent,
  ExchangeInput,
  GlobalContext,
  ParsedUri,
  RunEvent,
  SourceContext,
} from '@mt/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEventsSource, createEventsTarget } from '../../src/events.js'

const publisherItems: unknown[] = []

registry.registerSource('events-publisher-source', (uri) => ({
  uri: uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const item of publisherItems) yield { item }
  },
}))

describe('events scheme', () => {
  const makeUri = (raw: string): ParsedUri => {
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

  const sourceCtx = {
    run: { runId: 'test-run', global: { project: { name: 'test', root: tmpdir() }, settings: {} } },
  } as unknown as SourceContext

  let projectRoot: string

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'mt-events-waypoint-'))
    publisherItems.length = 0
  })

  function globalContext(): GlobalContext {
    return {
      project: { name: 'events-test', root: projectRoot },
      defaults: {
        retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
        onError: 'fail-run',
        concurrency: 1,
      },
      settings: {},
      env: {},
    }
  }

  /**
   * Run a publisher pipeline that emits `count` custom events on `channel` and then ends.
   * The run's end closes the channel — that is what ends a subscriber.
   */
  async function publish(channel: string, count: number, payload?: unknown): Promise<string> {
    publisherItems.length = 0
    for (let index = 0; index < count; index++) publisherItems.push(index)
    const pipeline = definePipeline({ id: 'events-publisher' })
      .from('events-publisher-source://in')
      .tap(() => {
        emitEvent(channel, payload)
      })
    const runner = new Runner(pipeline, globalContext())
    await runner.start()
    const runId = runner.getRunId()
    if (!runId) throw new Error('run did not mint a runId')
    return runId
  }

  /** Drain a source into an array — resolves when the source ends its stream. */
  async function drain(
    iterator: AsyncIterator<ExchangeInput<BusEvent>>,
  ): Promise<ExchangeInput<BusEvent>[]> {
    const out: ExchangeInput<BusEvent>[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done) return out
      out.push(next.value)
    }
  }

  it('target filters by qualifier', async () => {
    const ctx = {
      events: {
        subscribe: (listener: (e: { type: string }) => void) => {
          listener({ type: 'done' })
          listener({ type: 'failed' })
          listener({ type: 'done' })
          return () => {}
        },
      },
      run: { logger: { info: () => {} } },
    }

    const target = createEventsTarget(makeUri('events://test?only=done'))
    await target.open(ctx)
    await target.close(ctx)
    expect(target.uri).toBe('events://test?only=done')
  })

  it('target logs terminal event after close and ignores non-terminal events after close', async () => {
    let emit: ((e: RunEvent) => void) | undefined
    const info = vi.fn()
    const ctx = {
      events: {
        subscribe: (listener: (e: RunEvent) => void) => {
          emit = listener
          return () => {}
        },
      },
      run: { logger: { info } },
    }

    const target = createEventsTarget(makeUri('events://lifecycle?only=done,failed'))
    await target.open(ctx)
    emit?.({ type: 'step-done', ts: '1', runId: 'r1' })
    await target.close(ctx)
    emit?.({ type: 'done', ts: '2', runId: 'r1' })
    emit?.({ type: 'failed', ts: '3', runId: 'r1' })

    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenLastCalledWith('[events:lifecycle] [lifecycle] done')
  })

  it('target logs through the shared line format when wired to createConsoleLogger', async () => {
    let emit: ((e: RunEvent) => void) | undefined
    const ctx = {
      events: {
        subscribe: (listener: (e: RunEvent) => void) => {
          emit = listener
          return () => {}
        },
      },
      run: { logger: createConsoleLogger() },
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const target = createEventsTarget(makeUri('events://lifecycle?only=done,failed'))
    await target.open(ctx)
    await target.close(ctx)
    emit?.({ type: 'done', ts: '2', runId: 'r1' })

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenLastCalledWith(
      expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] \[events:lifecycle\] \[lifecycle\] done$/,
      ),
    )
    logSpy.mockRestore()
  })

  it('source is a live stream — it cannot be resumed', () => {
    const source = createEventsSource(makeUri('events://default?only=done'))
    expect(source.uri).toContain('events://')
    expect(source.lifestyle).toBe('long-lived')
  })

  it('custom channel: yields the published event and ends when the channel closes', async () => {
    const source = createEventsSource<BusEvent>(makeUri('events://custom-chan'))
    const iterator = source.start(sourceCtx)[Symbol.asyncIterator]()
    // The generator body runs synchronously on the first next() — the channel is subscribed.
    const collected = drain(iterator)

    const runId = await publish('custom-chan', 1, { hello: 'world' })
    const events = await collected

    expect(events).toHaveLength(1)
    expect(events[0]?.item.type).toBe('custom-chan')
    expect(events[0]?.item.payload).toEqual({ hello: 'world' })
    expect(events[0]?.item.runId).toBe(runId)
    expect(events[0]?.meta.eventName).toBe('custom-chan')
    expect(events[0]?.id).toContain('custom-chan')
  })

  it('custom channel: a late subscriber still sees the published event (history replay)', async () => {
    const runId = await publish('late-chan', 1, 'payload')

    const source = createEventsSource<BusEvent>(makeUri('events://late-chan'))
    const events = await drain(source.start(sourceCtx)[Symbol.asyncIterator]())

    expect(events).toHaveLength(1)
    expect(events[0]?.item.payload).toBe('payload')
    expect(events[0]?.item.runId).toBe(runId)
  })

  it('custom channel: ?limit= ends the stream after N events', async () => {
    const source = createEventsSource<BusEvent>(makeUri('events://limit-chan?limit=1'))
    const iterator = source.start(sourceCtx)[Symbol.asyncIterator]()
    const collected = drain(iterator)

    await publish('limit-chan', 2, 'payload')
    const events = await collected

    expect(events).toHaveLength(1)
  })

  it('lifecycle channel: yields the started event and ends on a terminal event', async () => {
    // The publisher runs first: the lifecycle events of its run are in the bus history.
    const runId = await publish('lifecycle-chan', 1)

    const source = createEventsSource<BusEvent>(makeUri('events://started'))
    const events = await drain(source.start(sourceCtx)[Symbol.asyncIterator]())

    // Only the subscribed lifecycle type is delivered; the terminal event ends the stream.
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event) => event.item.type === 'started')).toBe(true)
    expect(events.some((event) => event.item.runId === runId)).toBe(true)
  })

  it('lifecycle channel: ?only= filters the delivered types', async () => {
    await publish('only-chan', 1)

    const source = createEventsSource<BusEvent>(makeUri('events://default?only=done'))
    const events = await drain(source.start(sourceCtx)[Symbol.asyncIterator]())

    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event) => event.item.type === 'done')).toBe(true)
  })

  it('a lifecycle subscription ends on its own when no other run is executing', async () => {
    // The subscription of a run that watches the lifecycle: its own run can never report
    // "done" (the run ends only after the stream closed), so the subscription must end
    // when no other run of the process is left.
    const pipeline = definePipeline({ id: 'events-solo-subscriber' })
      .from('events://started')
      .tap(() => {})

    const runner = new Runner(pipeline, globalContext())
    await runner.start()

    expect(runner.getRunId()).not.toBeNull()
  })
})
