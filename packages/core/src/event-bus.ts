import { AsyncLocalStorage } from 'node:async_hooks'
import { log } from './logging.js'

/**
 * One event on the process-wide bus.
 *
 * Lifecycle events (`started`, `step-done`, `paused`, `resumed`, `done`, `failed`) carry the
 * same fields as a {@link RunEvent}; custom events published with {@link emitEvent} carry a
 * `payload` instead.
 */
export interface BusEvent {
  /** Event name: a lifecycle type or a custom name from {@link emitEvent}. */
  type: string
  /** ISO-8601 timestamp. */
  ts: string
  /** Run that published it (known for lifecycle events and for custom events inside a run). */
  runId?: string
  /** Step id — lifecycle `step-done` only. */
  stepId?: string
  /** Error message — lifecycle `failed` only. */
  error?: string
  /** Payload of a custom event. */
  payload?: unknown
}

/**
 * Listener for bus events. May return a promise — the bus never awaits it; a rejection is
 * logged and never reaches the publisher.
 */
export type BusEventListener = (event: BusEvent) => void | Promise<void>

/** Events kept per channel — a late subscriber still sees what was published. */
const HISTORY_LIMIT = 100

/** One subscriber of a channel. */
interface Subscriber {
  listener: BusEventListener
  onClose?: () => void
}

/** One watcher of the live runs. */
interface RunWatcher {
  runId: string
  onChange: (otherRunsLive: boolean) => void
}

/** Per-channel state: bounded history, subscribers, emitter runs, closed flag. */
interface Channel {
  history: BusEvent[]
  subscribers: Set<Subscriber>
  emitters: Set<string>
  closed: boolean
}

/**
 * The bus itself.
 *
 * Every pipeline of the process shares one instance (module singleton), so two pipelines can
 * talk to each other without any extra wiring.
 */
class EventBus {
  private readonly channels = new Map<string, Channel>()

  /** Runs that are currently executing — nobody else can publish once this holds only the watcher. */
  private readonly liveRuns = new Set<string>()

  /** Watchers of the live runs. */
  private readonly runWatchers = new Set<RunWatcher>()

  /**
   * Publish one event to its channel.
   *
   * `emitterRunId` registers the publishing run as an emitter of the channel — that is what
   * makes the close rule work. Lifecycle events pass no emitter: a subscriber run would
   * otherwise keep its own channel open forever.
   */
  publish(event: BusEvent, emitterRunId?: string): void {
    const channel = this.channelFor(event.type)
    // A closed channel reopens on the next publish: a new publisher run starts a new generation.
    channel.closed = false
    channel.history.push(event)
    if (channel.history.length > HISTORY_LIMIT) channel.history.shift()
    if (emitterRunId !== undefined) channel.emitters.add(emitterRunId)
    for (const subscriber of [...channel.subscribers]) this.deliver(subscriber, event)
  }

  /**
   * Subscribe to a channel. The channel history is replayed to the listener first, then live
   * events arrive. `onClose` fires when the channel closes (all emitter runs ended).
   */
  subscribe(type: string, listener: BusEventListener, onClose?: () => void): () => void {
    const channel = this.channelFor(type)
    const subscriber: Subscriber = onClose === undefined ? { listener } : { listener, onClose }
    channel.subscribers.add(subscriber)
    // Replay first: a late subscriber still sees what was published before it attached.
    for (const event of [...channel.history]) this.deliver(subscriber, event)
    if (channel.closed) {
      channel.subscribers.delete(subscriber)
      this.notifyClose(subscriber)
    }
    return () => {
      channel.subscribers.delete(subscriber)
    }
  }

  /**
   * Register a run that is executing. A run that is live can still publish on a channel, so a
   * subscriber waits for it.
   */
  openRun(runId: string): void {
    this.liveRuns.add(runId)
    this.notifyRunWatchers()
  }

  /**
   * Drop a finished run from every channel's emitter set. A channel that had at least one
   * emitter and now has none is closed — its subscribers are notified.
   */
  closeRun(runId: string): void {
    this.liveRuns.delete(runId)
    for (const channel of this.channels.values()) {
      if (!channel.emitters.delete(runId)) continue
      if (channel.emitters.size > 0) continue
      this.closeChannel(channel)
    }
    this.notifyRunWatchers()
  }

  /**
   * Watch the runs of this process.
   *
   * `onChange` is called immediately and on every run start/end: `otherRunsLive` is true while
   * a run besides `runId` is still executing. A subscription that has nobody else to wait for
   * ends when it turns false.
   */
  subscribeRuns(runId: string, onChange: (otherRunsLive: boolean) => void): () => void {
    const watcher: RunWatcher = { runId, onChange }
    this.runWatchers.add(watcher)
    this.notifyWatcher(watcher)
    return () => {
      this.runWatchers.delete(watcher)
    }
  }

  /** Tell every watcher that the live runs changed. */
  private notifyRunWatchers(): void {
    for (const watcher of [...this.runWatchers]) this.notifyWatcher(watcher)
  }

  /** Tell one watcher whether another run is still executing. */
  private notifyWatcher(watcher: RunWatcher): void {
    let otherRunsLive = false
    for (const id of this.liveRuns) {
      if (id === watcher.runId) continue
      otherRunsLive = true
      break
    }
    try {
      watcher.onChange(otherRunsLive)
    } catch (error) {
      this.logListenerError('run-watch', error)
    }
  }

  /** The channel of `type`, created on first use. */
  private channelFor(type: string): Channel {
    const existing = this.channels.get(type)
    if (existing) return existing
    const channel: Channel = {
      history: [],
      subscribers: new Set(),
      emitters: new Set(),
      closed: false,
    }
    this.channels.set(type, channel)
    return channel
  }

  /** Hand one event to one subscriber; a failing listener never reaches the publisher. */
  private deliver(subscriber: Subscriber, event: BusEvent): void {
    try {
      const result = subscriber.listener(event)
      if (result instanceof Promise) {
        result.catch((error: unknown) => this.logListenerError(event.type, error))
      }
    } catch (error) {
      this.logListenerError(event.type, error)
    }
  }

  /** Close a channel: no emitter run is left, so no further event can arrive. */
  private closeChannel(channel: Channel): void {
    if (channel.closed) return
    channel.closed = true
    const subscribers = [...channel.subscribers]
    channel.subscribers.clear()
    for (const subscriber of subscribers) this.notifyClose(subscriber)
  }

  /** Tell one subscriber that its channel is closed. */
  private notifyClose(subscriber: Subscriber): void {
    const onClose = subscriber.onClose
    if (!onClose) return
    try {
      onClose()
    } catch (error) {
      this.logListenerError('close', error)
    }
  }

  /** A broken listener is a warning, never a failed publish. */
  private logListenerError(eventType: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('event bus listener failed', { eventType, error: message })
  }
}

/** The process-wide bus — every pipeline of the process shares it. */
const bus = new EventBus()

/**
 * The run context of the currently executing run.
 *
 * `AsyncLocalStorage` so a `emitEvent()` deep inside a tool or a `.tap()` callback still knows
 * which run it belongs to, without threading the run id through every signature.
 */
const runStore = new AsyncLocalStorage<{ runId: string }>()

/**
 * Run `fn` inside the run context of `runId`. The Runner wraps the whole pipeline execution
 * in it, so every step of the run sees the same run id.
 */
export function withRunContext<T>(runId: string, fn: () => T): T {
  return runStore.run({ runId }, fn)
}

/** The run id of the currently executing run, if any. */
function currentRunId(): string | undefined {
  return runStore.getStore()?.runId
}

/**
 * Publish a custom event on the bus.
 *
 * Inside a run the event carries the run id and the run becomes an emitter of the channel —
 * the channel closes once every publishing run has ended, which is what ends a subscriber.
 * Outside a run the event is published without an emitter.
 *
 * @param type - Channel name (non-empty).
 * @param payload - Optional payload; delivered as `event.payload`.
 */
export function emitEvent(type: string, payload?: unknown): BusEvent {
  if (typeof type !== 'string' || type.trim().length === 0) {
    throw new TypeError(`emitEvent(type, payload): type must be a non-empty string, got '${type}'`)
  }
  const event: BusEvent = { type, ts: new Date().toISOString() }
  if (payload !== undefined) event.payload = payload
  const runId = currentRunId()
  if (runId === undefined) {
    bus.publish(event)
    return event
  }
  event.runId = runId
  bus.publish(event, runId)
  return event
}

/**
 * Subscribe to a channel. The channel history is replayed to `onEvent` first, then live events
 * arrive. `onClose` fires when the channel closes (all emitter runs ended).
 *
 * @returns An unsubscribe function.
 */
export function subscribeEvent(
  type: string,
  onEvent: BusEventListener,
  onClose?: () => void,
): () => void {
  if (typeof type !== 'string' || type.trim().length === 0) {
    throw new TypeError(
      `subscribeEvent(type, onEvent): type must be a non-empty string, got '${type}'`,
    )
  }
  return bus.subscribe(type, onEvent, onClose)
}

/**
 * Publish a lifecycle event to the bus. The publishing run is NOT registered as an emitter:
 * a subscriber run would keep its own channel open forever. Lifecycle channels end on a
 * terminal event instead.
 */
export function publishBusEvent(event: BusEvent): void {
  bus.publish(event)
}

/**
 * Drop a finished run from every channel's emitter set. Channels that are now emitter-less
 * close — their subscribers are notified through `onClose`.
 */
export function closeBusRun(runId: string): void {
  bus.closeRun(runId)
}

/**
 * Register a run that is executing.
 *
 * The Runner calls this when a run starts and `closeBusRun()` when it ends. A subscriber uses
 * {@link subscribeBusRuns} to learn when no other run can publish on its channel anymore.
 */
export function openBusRun(runId: string): void {
  bus.openRun(runId)
}

/**
 * Watch the runs of this process.
 *
 * `onChange(otherRunsLive)` is called immediately and on every run start/end: `otherRunsLive`
 * is true while a run besides `runId` is still executing. A subscription that has nobody else
 * to wait for ends when it turns false.
 *
 * @returns An unsubscribe function.
 */
export function subscribeBusRuns(
  runId: string,
  onChange: (otherRunsLive: boolean) => void,
): () => void {
  return bus.subscribeRuns(runId, onChange)
}
