import { subscribeBusRuns, subscribeEvent } from '@mt/core'
import type {
  BusEvent,
  Exchange,
  ExchangeInput,
  ParsedUri,
  RunEvent,
  Source,
  SourceContext,
  Target,
  TargetContext,
} from '@mt/core'
import { registerWaypointPair } from './registration.js'

/** Lifecycle event types — a channel named after one of them is a lifecycle subscription. */
const LIFECYCLE_TYPES = new Set(['started', 'step-done', 'paused', 'resumed', 'done', 'failed'])

function parseQualifier(query: Record<string, string>): Set<string> | null {
  const raw = query.only ?? query.qualifier ?? query.filter ?? ''
  if (!raw) return null
  const set = new Set<string>()
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (trimmed) set.add(trimmed)
  }
  return set.size > 0 ? set : null
}

/**
 * `?limit=N` — stop after N delivered events.
 */
function parseLimit(query: Record<string, string>): number | undefined {
  const raw = query.limit
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`events:// ... ?limit=${raw}: limit must be a positive integer`)
  }
  return value
}

/**
 * `?timeout=<ms>` — stop after the timeout.
 */
function parseTimeout(query: Record<string, string>): number | undefined {
  const raw = query.timeout
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `events:// ... ?timeout=${raw}: timeout must be a non-negative number of milliseconds`,
    )
  }
  return value
}

/**
 * Channel name of an `events://` URI: the host, or the path without its leading slash
 * (`events://chapReceived` → `chapReceived`).
 */
function channelName(uri: ParsedUri): string {
  const raw = uri.host || uri.path || 'events'
  return raw.startsWith('/') ? raw.slice(1) : raw
}

function matches(event: RunEvent, filter: Set<string> | null): boolean {
  if (!filter) return true
  return filter.has(event.type)
}

function isTerminal(event: RunEvent): boolean {
  return event.type === 'done' || event.type === 'failed'
}

/**
 * The `events://` SOURCE — a live subscription to a bus channel.
 *
 * The channel name is the URI host (`events://chapReceived` → `chapReceived`). A name that is
 * a lifecycle type (`events://started`) subscribes to that lifecycle event; `?only=a,b`
 * subscribes to the listed lifecycle types and leaves the name a pure label. Any other name
 * is a CUSTOM channel: the events published there with `emitEvent()`.
 *
 * The stream is live — events are delivered as they arrive, not after a terminal event. The
 * channel history is replayed first, so a subscriber that attaches late still sees what was
 * published before it.
 *
 * End conditions: the channel closes (every run that published on it has ended) and no other
 * run of the process is executing — nobody else can publish anymore. `?limit=` and `?timeout=`
 * end the stream whenever they trigger.
 */
export function createEventsSource<T>(uri: ParsedUri): Source<T> {
  const name = channelName(uri)
  const filter = parseQualifier(uri.query)
  const limit = parseLimit(uri.query)
  const timeout = parseTimeout(uri.query)

  // `?only=` filters lifecycle events; a bare lifecycle name subscribes to that type.
  const lifecycle = filter !== null || LIFECYCLE_TYPES.has(name)
  const watched = filter !== null ? [...filter] : [name]

  /** Does this event belong to the subscription? */
  const delivers = (event: BusEvent): boolean => {
    if (filter !== null) return filter.has(event.type)
    if (lifecycle) return event.type === name
    return true
  }

  return {
    uri: uri.raw,
    // A live stream has no cursor to resume from.
    lifestyle: 'long-lived',

    async *start(ctx: SourceContext): AsyncIterable<ExchangeInput<T>> {
      const queue: BusEvent[] = []
      let stopped = false
      let timedOut = false
      let otherRunsLive = true
      let wake: (() => void) | null = null
      let timer: ReturnType<typeof setTimeout> | null = null

      const notify = (): void => {
        const resume = wake
        wake = null
        resume?.()
      }

      const onEvent = (event: BusEvent): void => {
        // Everything that was published before the end is delivered — the queue decides
        // when the stream stops, not the handler.
        if (delivers(event)) queue.push(event)
        notify()
      }

      const onClose = (): void => {
        stopped = true
        notify()
      }

      const unsubscribes = watched.map((type) => subscribeEvent(type, onEvent, onClose))
      // The subscription ends with the last other run of the process: nobody else can
      // publish on the channel once every other run has ended.
      const stopWatchingRuns = subscribeBusRuns(ctx.run.runId, (live) => {
        otherRunsLive = live
        notify()
      })
      let delivered = 0
      try {
        while (true) {
          const event = queue.shift()
          if (event !== undefined) {
            delivered += 1
            yield {
              id: `event:${name}:${delivered}:${event.ts}`,
              item: event as unknown as T,
              meta: { eventName: event.type, eventTs: event.ts, eventRunId: event.runId },
            }
            if (limit !== undefined && delivered >= limit) break
            continue
          }
          if (stopped || timedOut) break
          // A lifecycle channel has no producer to wait for: the lifecycle events come from
          // the runs themselves, so the subscription ends with the last other run of the
          // process. A custom channel ends when it closes (every publisher run has ended) —
          // its publisher may still start.
          if (lifecycle && !otherRunsLive) break
          await new Promise<void>((resolve) => {
            const finish = (): void => {
              if (timer !== null) {
                clearTimeout(timer)
                timer = null
              }
              if (wake === finish) wake = null
              resolve()
            }
            wake = finish
            if (timeout !== undefined) {
              timer = setTimeout(() => {
                timedOut = true
                finish()
              }, timeout)
            }
          })
          if (timedOut) break
        }
      } finally {
        if (timer !== null) clearTimeout(timer)
        for (const unsubscribe of unsubscribes) unsubscribe()
        stopWatchingRuns()
      }
    },
  }
}

/**
 * The `events://` TARGET — logs the run-lifecycle events of the CURRENT run.
 *
 * Asymmetric on purpose: the source watches the process-wide bus, the target stays run-scoped
 * (`ctx.events`) because a target belongs to one run.
 */
export function createEventsTarget<T>(uri: ParsedUri): Target<T> {
  const filter = parseQualifier(uri.query)
  const name = uri.path || uri.host || 'events'
  let unsubscribe: (() => void) | undefined
  let closing = false
  let finished = false
  let committedEnvelopes = 0

  const logEvent = (logger: TargetContext['run']['logger'] | undefined, event: RunEvent) => {
    const step = event.stepId ? ` step=${event.stepId}` : ''
    const error = event.error ? ` error=${event.error}` : ''
    const line = `[lifecycle] ${event.type}${step}${error}`
    logger?.info(`[events:${name}] ${line}`)
  }

  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      committedEnvelopes = 0
      unsubscribe = ctx.events?.subscribe((event: RunEvent) => {
        if (finished) return
        if (closing && !isTerminal(event)) return
        if (!matches(event, filter)) return
        logEvent(ctx.run.logger, event)
        if (closing && isTerminal(event)) {
          finished = true
          unsubscribe?.()
          unsubscribe = undefined
        }
      })
    },
    async write(_env: Exchange<T>, _ctx: TargetContext): Promise<void> {
      // Subscription handle, not storage: delivering an item is a no-op, but count
      // it so the runner does not replay envelopes this sink has accepted.
      committedEnvelopes += 1
    },
    async checkpoint(): Promise<number> {
      return committedEnvelopes
    },
    async close(_ctx: TargetContext): Promise<void> {
      // The runner emits terminal events after closing the final target, so
      // keep the subscription alive long enough to log the run outcome.
      closing = true
    },
  }
}

registerWaypointPair({
  id: 'WT010',
  source: {
    factory: createEventsSource,
    name: 'events source',
    description:
      'Subscribes to a bus channel: run lifecycle events or custom events published with emitEvent().',
    schemes: ['events'],
  },
  target: {
    factory: createEventsTarget,
    name: 'events target',
    description: 'Logs run lifecycle events through the run logger via a subscription.',
    schemes: ['events'],
  },
})
