import { emitEvent } from '@mt/core'
import type { Exchange, ParsedUri, Target, TargetContext } from '@mt/core'
import { registerWaypointPair } from './registration.js'

/** Lifecycle names are reserved for the Runner — an emit channel must not shadow one. */
const LIFECYCLE_TYPES = new Set(['started', 'step-done', 'paused', 'resumed', 'done', 'failed'])

/** Shape of the payload published on the bus. */
export type EmitPayload = 'item' | 'items' | 'envelope' | 'meta'

export interface EmitTargetOptions {
  /** Payload shape; overrides `?payload=`. */
  payload?: EmitPayload
}

/**
 * Channel name of an `emit://` URI: the host, or the path without its leading slash
 * (`emit://chapterReady` → `chapterReady`).
 */
function channelName(uri: ParsedUri): string {
  const raw = uri.host || uri.path || ''
  const name = raw.startsWith('/') ? raw.slice(1) : raw
  if (name.length === 0) {
    throw new Error('emit:// requires a channel name: emit://<channel>')
  }
  if (LIFECYCLE_TYPES.has(name)) {
    throw new Error(
      `emit://${name}: '${name}' is a lifecycle event type; choose a custom channel name`,
    )
  }
  return name
}

function parsePayload(value: string | undefined): EmitPayload {
  if (value === undefined) return 'item'
  if (value === 'item' || value === 'items' || value === 'envelope' || value === 'meta') {
    return value
  }
  throw new Error(
    `Invalid emit:// payload '${value}'. Expected one of: item, items, envelope, meta`,
  )
}

/** Build the bus payload from an exchange. Pure. */
export function emitPayload<T>(env: Exchange<T>, mode: EmitPayload): unknown {
  if (mode === 'item') return env.item
  if (mode === 'items') return env.items
  if (mode === 'meta') return env.meta
  const payload: Record<string, unknown> = { id: env.id, item: env.item }
  if (env.items !== undefined) payload.items = env.items
  payload.meta = env.meta
  payload.variables = env.variables
  return payload
}

/**
 * `emit://<channel>` TARGET — publish every envelope as a custom event on the
 * process-wide bus.
 *
 * The counterpart is the `events://<channel>` source: a pipeline in the same process can
 * subscribe to the channel and receives the payloads (plus the channel history on a late
 * attach). `emitEvent()` marks this run as the channel's emitter, so the channel closes when
 * the run ends and the subscriber's stream finishes on its own.
 *
 * Payload selection — `?payload=item|items|envelope|meta` (default `item`):
 *
 * - `item` — `exchange.item` (the default; smallest useful payload)
 * - `items` — `exchange.items` (batch subflow output)
 * - `meta` — `exchange.meta`
 * - `envelope` — `{ id, item, items?, meta, variables }`
 */
export function createEmitTarget<T>(uri: ParsedUri, options?: EmitTargetOptions): Target<T> {
  const channel = channelName(uri)
  const payloadMode = options?.payload ?? parsePayload(uri.query.payload)
  let committedEnvelopes = 0

  return {
    uri: uri.raw,
    async open(_ctx: TargetContext): Promise<void> {
      committedEnvelopes = 0
    },
    async write(env: Exchange<T>, _ctx: TargetContext): Promise<void> {
      emitEvent(channel, emitPayload(env, payloadMode))
      committedEnvelopes += 1
    },
    async checkpoint(): Promise<number> {
      return committedEnvelopes
    },
    async close(_ctx: TargetContext): Promise<void> {
      // No-op: every envelope is already published by write().
    },
  }
}

// Register built-in emit target (target-only: no source registration)
registerWaypointPair({
  id: 'WT017',
  target: {
    factory: createEmitTarget,
    name: 'emit target',
    description:
      'Publishes every envelope as a custom event on the process-wide bus so an events:// source can subscribe.',
    schemes: ['emit'],
  },
})
