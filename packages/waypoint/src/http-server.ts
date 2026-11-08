import type { IncomingMessage, ServerResponse } from 'node:http'
import { type SourceContext, acquireListener, newExchangeId, registry } from '@mt/core'
import type { Exchange, ExchangeInput, RunEvent, Source } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { parseSizeOption } from './parse-options.js'
import { registerWaypointPair } from './registration.js'

/**
 * Built-in HTTP Source — long-lived HTTP server that receives envelopes via POST.
 * Supports POST /<path> for ingest, GET /health for health check, and GET /events for SSE.
 *
 * The listener comes from `@mt/core`'s refcounted registry, so `hs://` sources and a running
 * `mt serve` share one `http.Server` per `host:port`. When the listener is shared, `/events`
 * and `/health` move under the ingest path prefix (`<ingest>/events`, `<ingest>/health`) to
 * avoid clobbering admin endpoints; ingest paths under `/api/*` are rejected.
 *
 * `/events` is a read-only fan-out of the envelopes handed to the pipeline: it never consumes
 * the ingest buffer, and a subscriber is dropped as soon as its socket closes.
 *
 * Query options:
 *   - `port`         listen port (default 8080)
 *   - `count`        stop after N envelopes yielded (tests / bounded runs)
 *   - `maxBodyBytes` reject request bodies over this size with 413 (default 1 MiB)
 *   - `maxBuffer`    answer 503 once this many envelopes are undelivered (default 1000)
 *
 * Scheme aliases:
 *   - `http://host:port/path?query`  (legacy)
 *   - `hs://host:port/path?query`    ("http server" shorthand)
 */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_MAX_BUFFER = 1000

/** Lifecycle events mirrored from the run event log to `/events` subscribers. */
const MIRRORED_LIFECYCLE_TYPES = new Set(['paused', 'resumed', 'done', 'failed'])

/** Seconds a producer should wait before retrying a 503 (buffer full). */
const RETRY_AFTER_SECONDS = 1

function normalizeIngestPath(path: string): string {
  if (path === '' || path === '/') return '/'
  const withSlash = path.startsWith('/') ? path : `/${path}`
  return withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash
}

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/')
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function envValue(ctx: SourceContext, key: string): string | undefined {
  const fromContext = ctx.run.global?.env?.[key]
  const value = fromContext ?? process.env[key]
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** Child mode: hand the parent the loopback URL it should forward ingest bodies to. */
async function registerWithParent(
  parentUrl: string,
  payload: { path: string; runId: string; targetUrl: string },
): Promise<void> {
  const url = `${parentUrl.replace(/\/+$/, '')}/api/ingest/register`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Failed to register hs:// ingest path '${payload.path}' with parent ${parentUrl}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`,
    )
  }
}

async function deregisterFromParent(parentUrl: string, path: string): Promise<void> {
  const url = `${parentUrl.replace(/\/+$/, '')}/api/ingest/register`
  await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}

export function createHttpSource<T>(uri: ParsedUri): Source<T> {
  // Parse port from host (e.g. localhost:9876) or query.port (default 8080)
  let displayHost = uri.host || '127.0.0.1'
  let port = uri.query.port ? Number.parseInt(uri.query.port, 10) : 8080

  if (displayHost.includes(':')) {
    const [h, p] = displayHost.split(':')
    displayHost = h as string
    const parsedPort = Number.parseInt(p as string, 10)
    if (!Number.isNaN(parsedPort)) {
      port = parsedPort
    }
  }

  // The URI path is the ingest endpoint
  const ingestPath = normalizeIngestPath(uri.path || '/ingest')

  // Optional envelope count limit (for tests)
  const maxCount = uri.query.count ? Number.parseInt(uri.query.count, 10) : undefined

  // Ingest guards: body size cap and undelivered-buffer cap (backpressure signal)
  const maxBodyBytes = parseSizeOption(uri.query.maxBodyBytes, DEFAULT_MAX_BODY_BYTES)
  const maxBuffer = parseSizeOption(uri.query.maxBuffer, DEFAULT_MAX_BUFFER)

  return {
    uri: uri.raw,
    lifestyle: 'long-lived',

    async *start(ctx: SourceContext): AsyncIterable<ExchangeInput<T>> {
      // Admin routes are reserved: sharing the `mt serve` listener must not shadow `/api/*`.
      if (isApiPath(ingestPath)) {
        throw new Error(
          `hs:// ingest path '${ingestPath}' collides with the /api/* admin namespace; choose another path`,
        )
      }

      // Producer-consumer pattern: buffer + waiting resolvers
      const buffer: Exchange<T>[] = []
      const waiting: ((value: Exchange<T>) => void)[] = []
      // Read-only fan-out of delivered envelopes to /events subscribers
      const subscribers = new Set<ServerResponse>()

      let receivedCount = 0

      const sendToSubscribers = (payload: string): void => {
        for (const subscriber of subscribers) {
          if (subscriber.writableEnded) {
            subscribers.delete(subscriber)
            continue
          }
          try {
            subscriber.write(payload)
          } catch {
            subscribers.delete(subscriber)
          }
        }
      }

      const deliverEnvelope = (envelope: Exchange<T>): void => {
        // Mirror to subscribers before handing over to the pipeline — a failed
        // socket must never break ingest.
        sendToSubscribers(`data: ${JSON.stringify(envelope)}\n\n`)

        if (waiting.length > 0) {
          const resolver = waiting.shift() as (value: Exchange<T>) => void
          resolver(envelope)
        } else {
          buffer.push(envelope)
        }
      }

      // Cross-process mode: the worker does not bind the pipeline-declared port; it binds a
      // loopback ephemeral listener and lets `mt serve` forward `POST <path>` to it.
      const parentUrl = envValue(ctx, 'MT_INGEST_PARENT')
      const bindHost = parentUrl
        ? '127.0.0.1'
        : displayHost === 'localhost'
          ? '127.0.0.1'
          : displayHost
      const bindPort = parentUrl ? 0 : port
      const lease = await acquireListener(bindHost, bindPort)

      // When another tenant already owns the listener, namespace health/events under the
      // ingest prefix (`/ingest/health`, `/ingest/events`) to leave `/health` and `/api/*` alone.
      const prefix = ingestPath === '/' ? '' : ingestPath
      const healthPath = lease.shared ? `${prefix}/health` : '/health'
      const eventsPath = lease.shared ? `${prefix}/events` : '/events'

      const handleHealth = (_req: IncomingMessage, res: ServerResponse): void => {
        sendJson(res, 200, { status: 'ok' })
      }

      const handleEvents = (req: IncomingMessage, res: ServerResponse): void => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })

        // Send initial comment to establish connection
        res.write(': connected\n\n')

        // Subscribe to the live fan-out only — buffered envelopes stay with the pipeline
        subscribers.add(res)

        const unsubscribe = () => {
          subscribers.delete(res)
        }
        req.on('close', unsubscribe)
        res.on('error', unsubscribe)
        res.on('finish', unsubscribe)
      }

      const handleIngest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const chunks: Buffer[] = []
        let bodyBytes = 0
        let tooLarge = false
        for await (const chunk of req as AsyncIterable<Buffer>) {
          bodyBytes += chunk.length
          // Keep draining an oversized body so the client gets a clean 413, not a reset
          if (tooLarge || bodyBytes > maxBodyBytes) {
            tooLarge = true
            continue
          }
          chunks.push(chunk)
        }

        if (tooLarge) {
          sendJson(res, 413, { error: 'Payload too large' })
          return
        }

        // Backpressure: refuse ingest rather than growing the buffer without bound
        if (buffer.length >= maxBuffer) {
          res.writeHead(503, {
            'Content-Type': 'application/json',
            'Retry-After': String(RETRY_AFTER_SECONDS),
          })
          res.end(JSON.stringify({ error: 'Buffer full' }))
          return
        }

        const body = Buffer.concat(chunks).toString('utf8')

        try {
          const parsedBody = JSON.parse(body) as T
          const envelope: Exchange<T> = {
            id: newExchangeId('http-'),
            item: parsedBody,
            meta: {},
            variables: [],
          }

          receivedCount++
          if (maxCount !== undefined && receivedCount > maxCount) {
            sendJson(res, 200, { received: true })
            return
          }

          // Producer-consumer: deliver to waiting consumer or buffer
          deliverEnvelope(envelope)

          sendJson(res, 200, { received: true })
        } catch (_err) {
          sendJson(res, 400, { error: 'Invalid JSON' })
        }
      }

      let disposeIngest: (() => void) | null = null
      let disposeHealth: (() => void) | null = null
      let disposeEvents: (() => void) | null = null
      let unsubscribeEvents: (() => void) | undefined
      let routesClosed = false

      const registerIngest = (strict: boolean): void => {
        if (routesClosed || disposeIngest) return
        try {
          disposeIngest = lease.addRoute(ingestPath, handleIngest)
        } catch (error) {
          // Initial open rejects a duplicate route; a resume re-add only warns so a
          // transient conflict cannot take the whole source down.
          if (strict) throw error
          ctx.run.logger.warn('Could not re-register hs:// ingest route', {
            path: ingestPath,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const unregisterIngest = (): void => {
        disposeIngest?.()
        disposeIngest = null
      }

      const removeAllRoutes = (): void => {
        routesClosed = true
        unregisterIngest()
        disposeHealth?.()
        disposeHealth = null
        disposeEvents?.()
        disposeEvents = null
      }

      try {
        disposeHealth = lease.addRoute(healthPath, handleHealth)
        disposeEvents = lease.addRoute(eventsPath, handleEvents)
        registerIngest(true)

        // Mirror run lifecycle events (paused/resumed/done/failed) into the same SSE stream,
        // so a tailing client sees run state changes next to the envelope fan-out.
        // Pause also withdraws the ingest route; resume puts it back.
        unsubscribeEvents = ctx.events?.subscribe((event: RunEvent) => {
          if (!MIRRORED_LIFECYCLE_TYPES.has(event.type)) return
          sendToSubscribers(`data: ${JSON.stringify({ type: 'lifecycle', event: event.type })}\n\n`)
          if (event.type === 'paused') {
            unregisterIngest()
          } else if (event.type === 'resumed') {
            registerIngest(false)
          } else if (event.type === 'done' || event.type === 'failed') {
            removeAllRoutes()
          }
        })

        if (parentUrl) {
          await registerWithParent(parentUrl, {
            path: ingestPath,
            runId: ctx.run.runId,
            targetUrl: `http://127.0.0.1:${lease.port}${ingestPath}`,
          })
        }

        ctx.run.logger.info(
          `HTTP source started on port ${lease.port}, ingest path: ${ingestPath}`,
          {
            host: lease.host,
            shared: lease.shared,
            ...(parentUrl ? { parent: parentUrl } : {}),
          },
        )

        let yieldedCount = 0

        // Yield envelopes as they arrive
        while (true) {
          // Wait for an envelope to be available
          const envelope = await new Promise<Exchange<T>>((resolve) => {
            // If buffer has items, take from there
            if (buffer.length > 0) {
              resolve(buffer.shift() as Exchange<T>)
            } else {
              // Otherwise wait for a producer to deliver
              waiting.push(resolve as (value: Exchange<T>) => void)
            }
          })

          yield envelope
          yieldedCount++
          if (maxCount !== undefined && yieldedCount >= maxCount) {
            break
          }
        }
      } finally {
        unsubscribeEvents?.()
        // An SSE response never ends by itself, so close() would wait forever:
        // end every subscriber before the lease release drops the listener.
        for (const subscriber of subscribers) {
          try {
            subscriber.end()
          } catch {
            // Socket already gone — nothing to end
          }
        }
        subscribers.clear()
        removeAllRoutes()

        if (parentUrl) {
          await deregisterFromParent(parentUrl, ingestPath).catch(() => undefined)
        }
        await lease.release()
        ctx.run.logger.info('HTTP source stopped')
      }
    },
  }
}

registerWaypointPair({
  id: 'WT003',
  // Registered under both the legacy and the shorthand scheme.
  source: {
    factory: createHttpSource,
    name: 'http source',
    description: 'Reads envelopes via HTTP POST on a long-lived local server.',
    schemes: ['hs', 'http'],
    registerSchemes: ['http', 'hs'],
  },
})
