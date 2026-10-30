import type { ParsedUri, RunEvent } from '@mt/core'
import { describe, expect, it, vi } from 'vitest'
import { createEventsSource, createEventsTarget } from '../../src/events.js'

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
    const ctx = {
      events: {
        subscribe: (listener: (e: RunEvent) => void) => {
          emit = listener
          return () => {}
        },
      },
      run: { logger: { info: () => {} } },
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const target = createEventsTarget(makeUri('events://lifecycle?only=done,failed'))
    await target.open(ctx)
    emit?.({ type: 'step-done', ts: '1', runId: 'r1' })
    await target.close(ctx)
    emit?.({ type: 'done', ts: '2', runId: 'r1' })
    emit?.({ type: 'failed', ts: '3', runId: 'r1' })

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenLastCalledWith('[events:lifecycle] [lifecycle] done')
    logSpy.mockRestore()
  })

  it('source yields matched events', async () => {
    const source = createEventsSource(makeUri('events://default?only=done'))
    expect(source.uri).toContain('events://')
    expect(source.lifestyle).toBe('resumable')
  })
})
