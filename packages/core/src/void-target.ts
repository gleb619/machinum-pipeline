import type { Exchange, Target } from './types.js'

/**
 * Core's fallback discard target — used when the `void` scheme is not registered (a core-only
 * setup without `@mt/waypoint`). Mirrors the waypoint void target: every envelope is counted
 * and dropped, and `checkpoint()` reports the count so a resume does not replay discarded work.
 */
export function createCoreVoidTarget<T>(uri = 'void://'): Target<T> {
  let committedEnvelopes = 0

  return {
    uri,
    async open(): Promise<void> {
      committedEnvelopes = 0
    },
    async write(_env: Exchange<T>): Promise<void> {
      committedEnvelopes += 1
    },
    async checkpoint(): Promise<number> {
      return committedEnvelopes
    },
    async close(): Promise<void> {
      // No-op
    },
  }
}
