import type { ParsedUri } from '@mt/core'
import type { Envelope, Target, TargetContext } from '@mt/core'
import { registry } from '@mt/core'

/**
 * Discard everything written to it (like /dev/null).
 *
 * URI scheme: void://
 *
 * open/write/close are all no-ops. There is deliberately NO checkpoint():
 * nothing is durable mid-run, so the runner keeps its cursor pre-run and a
 * crash replays the source — harmless for a sink that keeps no state.
 */
export function createVoidTarget<T>(uri: ParsedUri): Target<T> {
  return {
    uri: uri.raw,
    async open(_ctx: TargetContext): Promise<void> {
      // No-op
    },
    async write(_env: Envelope<T>, _ctx: TargetContext): Promise<void> {
      // No-op: discard the envelope
    },
    async close(_ctx: TargetContext): Promise<void> {
      // No-op
    },
  }
}

// Register built-in void target (target-only: no source registration)
registry.registerTarget('void', createVoidTarget)
