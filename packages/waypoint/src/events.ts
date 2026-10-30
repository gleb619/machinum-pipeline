import type { SourceContext, TargetContext } from '@mt/core'
import type { Exchange, ExchangeInput, RunEvent, Source, Target } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { registry } from '@mt/core'

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

function matches(event: RunEvent, filter: Set<string> | null): boolean {
  if (!filter) return true
  return filter.has(event.type)
}

function isTerminal(event: RunEvent): boolean {
  return event.type === 'done' || event.type === 'failed'
}

export function createEventsSource<T>(uri: ParsedUri): Source<T> {
  const filter = parseQualifier(uri.query)
  const name = uri.path || uri.host || 'events'

  return {
    uri: uri.raw,
    lifestyle: 'resumable',

    async *start(ctx: SourceContext): AsyncIterable<ExchangeInput<T>> {
      const events: RunEvent[] = []
      let unsubscribe: (() => void) | undefined
      const donePromise = new Promise<RunEvent>((resolve) => {
        unsubscribe = ctx.events?.subscribe((event: RunEvent) => {
          if (matches(event, filter)) {
            events.push(event)
          }
          if (isTerminal(event)) {
            resolve(event)
          }
        })
      })
      await donePromise
      unsubscribe?.()
      unsubscribe = undefined
      for (const ev of events) {
        yield {
          id: `events:${name}:${ev.type}:${ev.ts}`,
          item: ev as unknown as T,
          meta: { eventType: ev.type, eventSource: name },
        }
      }
    },
  }
}

export function createEventsTarget<T>(uri: ParsedUri): Target<T> {
  const filter = parseQualifier(uri.query)
  const name = uri.path || uri.host || 'events'
  let unsubscribe: (() => void) | undefined
  let closing = false
  let finished = false

  const logEvent = (event: RunEvent) => {
    const step = event.stepId ? ` step=${event.stepId}` : ''
    const error = event.error ? ` error=${event.error}` : ''
    const line = `[lifecycle] ${event.type}${step}${error}`
    console.log(`[events:${name}] ${line}`)
  }

  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      unsubscribe = ctx.events?.subscribe((event: RunEvent) => {
        if (finished) return
        if (closing && !isTerminal(event)) return
        if (!matches(event, filter)) return
        logEvent(event)
        if (closing && isTerminal(event)) {
          finished = true
          unsubscribe?.()
          unsubscribe = undefined
        }
      })
    },
    async write(_env: Exchange<T>, _ctx: TargetContext): Promise<void> {
      // No-op: events target is a subscription handle, not storage.
      // It should never receive pipeline items.
    },
    async close(_ctx: TargetContext): Promise<void> {
      // The runner emits terminal events after closing the final target, so
      // keep the subscription alive long enough to log the run outcome.
      closing = true
    },
  }
}

registry.registerSource('events', createEventsSource)
registry.registerTarget('events', createEventsTarget)
