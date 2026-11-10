import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Runner } from '../src/engine/runner.js'
import {
  closeBusRun,
  emitEvent,
  openBusRun,
  subscribeBusRuns,
  subscribeEvent,
  withRunContext,
} from '../src/event-bus.js'
import type { BusEvent } from '../src/event-bus.js'
import type { Envelope, GlobalContext, Pipeline } from '../src/types.js'
import { registry } from '../src/uri.js'

const sourceItems: Array<Envelope<unknown>> = []

registry.registerSource('bus-source', (uri) => ({
  uri: uri.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const env of sourceItems) yield env
  },
  async *resume() {
    for (const env of sourceItems) yield env
  },
}))

registry.registerTarget('bus-target', (uri) => ({
  uri: uri.raw,
  async open() {},
  async write(_env: Envelope<unknown>) {},
  async close() {},
}))

const defaultRetry = { max: 0, backoffMs: 0, strategy: 'fixed' as const }

function context(): GlobalContext {
  return {
    project: { name: 'event-bus-test', root: '/tmp/mt-event-bus-test' },
    defaults: { retry: defaultRetry, onError: 'fail-run' as const, concurrency: 1 },
    settings: {},
    env: {},
  }
}

describe('event bus', () => {
  beforeEach(() => {
    sourceItems.length = 0
  })

  it('delivers a published event to a subscriber and stops after unsubscribe', () => {
    const seen: BusEvent[] = []
    const unsubscribe = subscribeEvent('live-chan', (event) => {
      seen.push(event)
    })

    const published = emitEvent('live-chan', { n: 1 })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.type).toBe('live-chan')
    expect(seen[0]?.payload).toEqual({ n: 1 })
    expect(seen[0]?.ts).toBe(published.ts)

    unsubscribe()
    emitEvent('live-chan', { n: 2 })
    expect(seen).toHaveLength(1)
  })

  it('replays the channel history to a late subscriber', () => {
    emitEvent('history-chan', 'one')
    emitEvent('history-chan', 'two')

    const seen: BusEvent[] = []
    subscribeEvent('history-chan', (event) => {
      seen.push(event)
    })
    expect(seen.map((event) => event.payload)).toEqual(['one', 'two'])
  })

  it('rejects an empty event type', () => {
    expect(() => emitEvent('')).toThrow(TypeError)
    expect(() => subscribeEvent('', () => {})).toThrow(TypeError)
  })

  it('closes a channel only when every emitter run ended', () => {
    const seen: BusEvent[] = []
    let closed = false
    subscribeEvent(
      'close-chan',
      (event) => {
        seen.push(event)
      },
      () => {
        closed = true
      },
    )

    withRunContext('run-a', () => emitEvent('close-chan', 1))
    withRunContext('run-b', () => emitEvent('close-chan', 2))
    expect(closed).toBe(false)

    closeBusRun('run-a')
    expect(closed).toBe(false)

    closeBusRun('run-b')
    expect(closed).toBe(true)
    expect(seen).toHaveLength(2)
  })

  it('notifies a late subscriber of an already closed channel', () => {
    withRunContext('run-c', () => emitEvent('closed-chan', 'x'))
    closeBusRun('run-c')

    const seen: BusEvent[] = []
    let closed = false
    subscribeEvent(
      'closed-chan',
      (event) => {
        seen.push(event)
      },
      () => {
        closed = true
      },
    )
    expect(seen).toHaveLength(1)
    expect(closed).toBe(true)
  })

  it('tells a watcher when no other run is live', () => {
    const states: boolean[] = []
    const unsubscribe = subscribeBusRuns('watcher-run', (live) => states.push(live))
    // Nobody else is running yet.
    expect(states).toEqual([false])

    openBusRun('other-run')
    expect(states).toEqual([false, true])

    closeBusRun('other-run')
    expect(states).toEqual([false, true, false])

    unsubscribe()
    openBusRun('third-run')
    expect(states).toEqual([false, true, false])
  })

  it('never lets a failing listener break the publisher', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    subscribeEvent('reject-chan', () => {
      throw new Error('listener boom')
    })
    subscribeEvent('reject-chan', async () => {
      throw new Error('async listener boom')
    })

    const published = emitEvent('reject-chan', 'payload')
    expect(published.payload).toBe('payload')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('carries the run id into emitEvent and closes the channel when the run ends', async () => {
    sourceItems.push({ id: 'ex-bus', variables: [], item: 'a', meta: {} })
    const seen: BusEvent[] = []
    subscribeEvent('runner-chan', (event) => {
      seen.push(event)
    })

    const pipeline: Pipeline = {
      id: 'bus-runner',
      retry: defaultRetry,
      onError: 'fail-run',
      steps: [
        { type: 'source', config: { uri: 'bus-source://in' } },
        {
          type: 'tap',
          config: {
            fn: () => {
              emitEvent('runner-chan', { ok: true })
            },
          },
        },
        { type: 'target', config: { uri: 'bus-target://out' } },
      ],
    }

    const runner = new Runner(pipeline, context())
    await runner.start()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.runId).toBe(runner.getRunId())
    expect(seen[0]?.payload).toEqual({ ok: true })

    // The run ended — the channel it was emitting on is closed now.
    let closed = false
    subscribeEvent(
      'runner-chan',
      () => {},
      () => {
        closed = true
      },
    )
    expect(closed).toBe(true)
  })
})
