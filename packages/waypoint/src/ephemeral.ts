import type { SourceContext, TargetContext } from '@mt/core'
import type { Envelope, Source, Target } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { registry } from '@mt/core'

/**
 * Module-level in-memory buffer shared between ephemeral sources and targets.
 * Keyed by buffer name (derived from the URI path).
 */
const buffers = new Map<string, Envelope[]>()

/**
 * Read all envelopes from a named ephemeral buffer.
 *
 * URI scheme: ephemeral://<buffer-name>
 * Example: ephemeral://my-buffer → reads from buffer "my-buffer"
 *
 * Yields all envelopes currently in the buffer, then completes.
 * If no buffer exists under that name, yields nothing.
 */
export function createEphemeralSource<T>(uri: ParsedUri): Source<T> {
  const bufferName = uri.path || uri.host

  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(_ctx: SourceContext): AsyncIterable<Envelope<T>> {
      const batch = buffers.get(bufferName)
      if (batch && batch.length > 0) {
        for (const env of batch) {
          yield env as Envelope<T>
        }
      }
    },
    async *resume(_ctx: SourceContext, _cursor: unknown): AsyncIterable<Envelope<T>> {
      const batch = buffers.get(bufferName)
      if (batch && batch.length > 0) {
        for (const env of batch) {
          yield env as Envelope<T>
        }
      }
    },
  }
}

/**
 * Write envelopes to a named ephemeral buffer.
 *
 * URI scheme: ephemeral://<buffer-name>
 * Example: ephemeral://my-buffer → writes to buffer "my-buffer"
 *
 * On open(), the buffer is cleared to start fresh.
 * On write(), the envelope is appended to the buffer.
 * On close(), nothing is done (buffer stays in memory for sources to read).
 */
export function createEphemeralTarget<T>(uri: ParsedUri): Target<T> {
  const bufferName = uri.path || uri.host

  return {
    uri: uri.raw,
    async open(_ctx: TargetContext): Promise<void> {
      buffers.set(bufferName, [])
    },
    async write(env: Envelope<T>, _ctx: TargetContext): Promise<void> {
      const batch = buffers.get(bufferName)
      if (!batch) {
        buffers.set(bufferName, [env])
      } else {
        batch.push(env)
      }
    },
    async close(_ctx: TargetContext): Promise<void> {
      // No-op: buffer stays in memory for downstream sources
    },
  }
}

// Register built-in ephemeral source and target
registry.registerSource('ephemeral', createEphemeralSource)
registry.registerTarget('ephemeral', createEphemeralTarget)
