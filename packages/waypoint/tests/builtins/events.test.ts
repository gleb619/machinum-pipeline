import type { ParsedUri } from '@mt/core'
import { describe, expect, it } from 'vitest'
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

  it('source yields matched events', async () => {
    const source = createEventsSource(makeUri('events://default?only=done'))
    expect(source.uri).toContain('events://')
    expect(source.lifestyle).toBe('resumable')
  })
})
