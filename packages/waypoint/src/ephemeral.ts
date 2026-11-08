import type { SourceContext, TargetContext } from '@mt/core'
import type { Exchange, Source, Target } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { annotateWaypoint, registerWaypointPair } from './registration.js'
import { resumeFrom } from './resume.js'

/**
 * Module-level in-memory buffer shared between ephemeral sources and targets.
 * Keyed by buffer name (derived from the URI path).
 */
const buffers = new Map<string, Exchange[]>()

/** Clear a named buffer (used by both `ephemeral://` targets and auto-publish). */
export function resetNamedBuffer(name: string): void {
  buffers.set(name, [])
}

/** Append one envelope to a named buffer. */
export function appendNamedBuffer<T>(name: string, env: Exchange<T>): void {
  const batch = buffers.get(name)
  if (batch) {
    batch.push(env as Exchange<unknown>)
  } else {
    buffers.set(name, [env as Exchange<unknown>])
  }
}

/** Default buffer name for `ephemeral://`: the URI path, else host. */
function defaultBufferName(uri: ParsedUri): string {
  return uri.path || uri.host
}

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
  return createNamedEphemeralSource<T>(uri, defaultBufferName(uri))
}

/** Named form used by scheme aliases (`lines://`, `paragraphs://`, …). */
export function createNamedEphemeralSource<T>(uri: ParsedUri, bufferName: string): Source<T> {
  const readEnvelopes = async function* (): AsyncIterable<Exchange<T>> {
    const batch = buffers.get(bufferName)
    if (batch && batch.length > 0) {
      for (const env of batch) {
        yield env as Exchange<T>
      }
    }
  }

  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(_ctx: SourceContext): AsyncIterable<Exchange<T>> {
      yield* readEnvelopes()
    },
    async *resume(_ctx: SourceContext, cursor: unknown): AsyncIterable<Exchange<T>> {
      yield* resumeFrom(readEnvelopes, cursor)
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
  return createNamedEphemeralTarget<T>(uri, defaultBufferName(uri))
}

/** Named form used by scheme aliases (`lines://`, `paragraphs://`, …). */
export function createNamedEphemeralTarget<T>(uri: ParsedUri, bufferName: string): Target<T> {
  return {
    uri: uri.raw,
    async open(_ctx: TargetContext): Promise<void> {
      resetNamedBuffer(bufferName)
    },
    async write(env: Exchange<T>, _ctx: TargetContext): Promise<void> {
      appendNamedBuffer(bufferName, env)
    },
    async close(_ctx: TargetContext): Promise<void> {
      // No-op: buffer stays in memory for downstream sources. Deliberately no
      // checkpoint(): in-process state vanishes with the process, so a resume replays.
    },
  }
}

// Register built-in ephemeral source and target
registerWaypointPair({
  id: 'WT013',
  source: {
    factory: createEphemeralSource,
    name: 'ephemeral source',
    description: 'Reads envelopes from a process-local in-memory buffer.',
    schemes: ['ephemeral', 'mem'],
  },
  target: {
    factory: createEphemeralTarget,
    name: 'ephemeral target',
    description: 'Writes envelopes to a process-local in-memory buffer.',
    schemes: ['ephemeral', 'mem'],
  },
})
// The named forms back the scheme aliases — annotated, but registered by the caller.
annotateWaypoint(createNamedEphemeralSource, {
  id: 'WT013',
  name: 'named ephemeral source',
  description: 'Reads envelopes from a process-local in-memory buffer.',
  schemes: ['ephemeral'],
  direction: 'source',
})
annotateWaypoint(createNamedEphemeralTarget, {
  id: 'WT013',
  name: 'named ephemeral target',
  description: 'Writes envelopes to a process-local in-memory buffer.',
  schemes: ['ephemeral'],
  direction: 'target',
})
