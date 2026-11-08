import type { ParsedUri } from '@mt/core'
import type { Exchange, Target, TargetContext } from '@mt/core'
import { registerWaypointPair } from './registration.js'

/**
 * Discard everything written to it (like /dev/null).
 *
 * URI scheme: void://
 *
 * open/close are no-ops. `checkpoint()` counts the envelopes the runner handed over,
 * so a resume does not replay work whose only effect was discarding it.
 */
export function createVoidTarget<T>(uri: ParsedUri): Target<T> {
  let committedEnvelopes = 0

  return {
    uri: uri.raw,
    async open(_ctx: TargetContext): Promise<void> {
      committedEnvelopes = 0
    },
    async write(_env: Exchange<T>, _ctx: TargetContext): Promise<void> {
      committedEnvelopes += 1
    },
    async checkpoint(): Promise<number> {
      return committedEnvelopes
    },
    async close(_ctx: TargetContext): Promise<void> {
      // No-op
    },
  }
}

// Register built-in void target (target-only: no source registration)
registerWaypointPair({
  id: 'WT008',
  target: {
    factory: createVoidTarget,
    name: 'void target',
    description: 'Discards every envelope written to it, like /dev/null.',
    schemes: ['void'],
  },
})
