import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { SourceContext } from '@mt/core'
import type { Envelope, RunEvent, Source } from '@mt/core'
import type { ParsedUri } from '@mt/core'
import { registry } from '@mt/core'

/**
 * Built-in HTTP Source — long-lived HTTP server that receives envelopes via POST.
 * Supports POST /<path> for ingest, GET /health for health check, and GET /events for SSE.
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

function parseSizeOption(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed
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
  const ingestPath = uri.path || '/ingest'

  // Optional envelope count limit (for tests)
  const maxCount = uri.query.count ? Number.parseInt(uri.query.count, 10) : undefined

  // Ingest guards: body size cap and undelivered-buffer cap (backpressure signal)
  const maxBodyBytes = parseSizeOption(uri.query.maxBodyBytes, DEFAULT_MAX_BODY_BYTES)
  const maxBuffer = parseSizeOption(uri.query.maxBuffer, DEFAULT_MAX_BUFFER)

  return {
    uri: uri.raw,
    lifestyle: 'long-lived',

    async *start(ctx: SourceContext): AsyncIterable<Envelope<T>> {
      // Producer-consumer pattern: buffer + waiting resolvers
      const buffer: Envelope<T>[] = []
      const waiting: ((value: Envelope<T>) => void)[] = []
      // Read-only fan-out of delivered envelopes to /events subscribers
      const subscribers = new Set<ServerResponse>()

      let server: Server | null = null
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

      const deliverEnvelope = (envelope: Envelope<T>): void => {
        // Mirror to subscribers before handing over to the pipeline — a failed
        // socket must never break ingest.
        sendToSubscribers(`data: ${JSON.stringify(envelope)}\n\n`)

        if (waiting.length > 0) {
          const resolver = waiting.shift() as (value: Envelope<T>) => void
          resolver(envelope)
        } else {
          buffer.push(envelope)
        }
      }

      // Mirror run lifecycle events (paused/resumed/done/failed) into the same SSE stream,
      // so a tailing client sees run state changes next to the envelope fan-out.
      const unsubscribeEvents = ctx.events?.subscribe((event: RunEvent) => {
        if (!MIRRORED_LIFECYCLE_TYPES.has(event.type)) return
        sendToSubscribers(`data: ${JSON.stringify({ type: 'lifecycle', event: event.type })}\n\n`)
      })

      // Create HTTP server
      server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = req.url ?? ''
        const method = req.method ?? 'GET'

        // Normalize path (remove query string)
        const pathname = url.split('?')[0] ?? ''

        // GET /health - health check endpoint
        if (method === 'GET' && pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'ok' }))
          return
        }

        // GET /events - SSE endpoint for streaming envelopes
        if (method === 'GET' && pathname === '/events') {
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

          return
        }

        // POST /<path> - ingest endpoint
        if (method === 'POST' && pathname === ingestPath) {
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
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Payload too large' }))
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
            const envelope: Envelope<T> = {
              item: parsedBody,
              meta: {},
            }

            receivedCount++
            if (maxCount !== undefined && receivedCount > maxCount) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ received: true }))
              return
            }

            // Producer-consumer: deliver to waiting consumer or buffer
            deliverEnvelope(envelope)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ received: true }))
          } catch (_err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid JSON' }))
          }
          return
        }

        // 404 for unknown endpoints
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
      })

      // Start server on 127.0.0.1 to avoid IPv6 issues in tests
      await new Promise<void>((resolve) => {
        server?.listen(port, '127.0.0.1', () => {
          resolve()
        })
      })

      // Get actual port if port was 0 (ephemeral)
      const actualPort = (server.address() as { port: number }).port
      ctx.run.logger.info(`HTTP source started on port ${actualPort}, ingest path: ${ingestPath}`)

      let yieldedCount = 0

      try {
        // Yield envelopes as they arrive
        while (true) {
          // Wait for an envelope to be available
          const envelope = await new Promise<Envelope<T>>((resolve) => {
            // If buffer has items, take from there
            if (buffer.length > 0) {
              resolve(buffer.shift() as Envelope<T>)
            } else {
              // Otherwise wait for a producer to deliver
              waiting.push(resolve as (value: Envelope<T>) => void)
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
        // Clean up server
        const httpServer = server
        if (httpServer) {
          // An SSE response never ends by itself, so close() would wait forever:
          // end every subscriber, then drop whatever sockets are still open.
          for (const subscriber of subscribers) {
            try {
              subscriber.end()
            } catch {
              // Socket already gone — nothing to end
            }
          }
          subscribers.clear()
          httpServer.closeAllConnections()

          await new Promise<void>((resolve) => {
            httpServer.close(() => {
              resolve()
            })
          })
          ctx.run.logger.info('HTTP source stopped')
        }
      }
    },
  }
}

// Register built-in HTTP source under both legacy and shorthand schemes
registry.registerSource('http', createHttpSource)
registry.registerSource('hs', createHttpSource)
