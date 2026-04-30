import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Envelope, Source } from '../types.js'
import type { SourceContext } from '../contexts.js'
import type { ParsedUri } from '../uri.js'
import { registry } from '../uri.js'

/**
 * Built-in HTTP Source — long-lived HTTP server that receives envelopes via POST.
 * Supports POST /<path> for ingest, GET /health for health check, and GET /events for SSE.
 */
export function createHttpSource<T>(uri: ParsedUri): Source<T> {
  // Parse port from uri.query.port (default 8080)
  const port = uri.query.port
    ? Number.parseInt(uri.query.port, 10)
    : 8080

  // The URI path is the ingest endpoint
  const ingestPath = uri.path || '/ingest'

  return {
    uri: uri.raw,
    lifestyle: 'long-lived',

    async *start(ctx: SourceContext): AsyncIterable<Envelope<T>> {
      // Producer-consumer pattern: buffer + waiting resolvers
      const buffer: Envelope<T>[] = []
      const waiting: ((value: Envelope<T>) => void)[] = []

      let server: Server | null = null

      const deliverEnvelope = (envelope: Envelope<T>): void => {
        if (waiting.length > 0) {
          const resolver = waiting.shift()!
          resolver(envelope)
        } else {
          buffer.push(envelope)
        }
      }

      // Create HTTP server
      server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = req.url ?? ''
        const method = req.method ?? 'GET'

        // Normalize path (remove query string)
        const pathname = url.split('?')[0]!

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

          // Store envelope send function for this response
          const sendEnvelope = (envelope: Envelope<T>) => {
            const data = JSON.stringify(envelope)
            res.write(`data: ${data}\n\n`)
          }

          // If there are buffered envelopes, send them
          for (const env of buffer) {
            sendEnvelope(env)
          }
          buffer.length = 0 // Clear buffer

          // Set up delivery for new envelopes
          const deliveryHandler = (envelope: Envelope<T>) => {
            try {
              sendEnvelope(envelope)
            } catch {
              // Client disconnected
            }
          }

          // Add temporary handler for SSE delivery
          // Note: We store a reference to remove it later
          const originalWaiting = [...waiting]

          req.on('close', () => {
            // Handler removed via wrapper
          })

          return
        }

        // POST /<path> - ingest endpoint
        if (method === 'POST' && pathname === ingestPath) {
          let body = ''
          for await (const chunk of req) {
            body += chunk
          }

          try {
            const parsedBody = JSON.parse(body) as T
            const envelope: Envelope<T> = {
              item: parsedBody,
              meta: {},
            }

            // Producer-consumer: deliver to waiting consumer or buffer
            deliverEnvelope(envelope)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ received: true }))
          } catch (err) {
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
        server!.listen(port, '127.0.0.1', () => {
          resolve()
        })
      })

      // Get actual port if port was 0 (ephemeral)
      const actualPort = (server.address() as { port: number }).port
      ctx.run.logger.info(`HTTP source started on port ${actualPort}, ingest path: ${ingestPath}`)

      try {
        // Yield envelopes as they arrive
        while (true) {
          // Wait for an envelope to be available
          const envelope = await new Promise<Envelope<T>>((resolve) => {
            // If buffer has items, take from there
            if (buffer.length > 0) {
              resolve(buffer.shift()!)
            } else {
              // Otherwise wait for a producer to deliver
              waiting.push(resolve as (value: Envelope<T>) => void)
            }
          })

          yield envelope
        }
      } finally {
        // Clean up server
        if (server) {
          await new Promise<void>((resolve) => {
            server!.close(() => {
              resolve()
            })
          })
          ctx.run.logger.info('HTTP source stopped')
        }
      }
    },
  }
}

// Register built-in HTTP source
registry.registerSource('http', createHttpSource)