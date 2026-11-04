import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HttpRouteHandler } from '@mt/core'

/** Minimal listener surface needed to mount a forwarding route. */
export interface IngestMount {
  addRoute(path: string, handler: HttpRouteHandler): () => void
}

interface RegisteredIngest {
  readonly path: string
  readonly runId: string
  readonly targetUrl: string
  readonly dispose: () => void
}

export interface RegisterIngestInput {
  path: string
  runId: string
  targetUrl: string
}

const routes = new Map<string, RegisteredIngest>()
let mount: IngestMount | null = null

function isLoopback(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.')
}

function validatePath(path: string): void {
  if (!path.startsWith('/')) throw new Error("ingest path must start with '/'")
  if (path === '/api' || path.startsWith('/api/')) {
    throw new Error(`ingest path '${path}' collides with the /api/* admin namespace`)
  }
}

function validateTargetUrl(targetUrl: string): URL {
  let url: URL
  try {
    url = new URL(targetUrl)
  } catch {
    throw new Error(`ingest target URL '${targetUrl}' is not a valid URL`)
  }
  if (url.protocol !== 'http:') throw new Error('ingest target URL must use http:')
  if (!isLoopback(url.hostname)) {
    throw new Error('ingest target URL must point at a loopback interface')
  }
  return url
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function forwarder(target: URL): HttpRouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req)
    let upstream: Response
    try {
      upstream = await fetch(target, {
        method: req.method ?? 'POST',
        headers: {
          'Content-Type': req.headers['content-type'] ?? 'application/json',
        },
        body: new Uint8Array(body),
      })
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Ingest target unavailable' }))
      return
    }

    const text = await upstream.text()
    const headers: Record<string, string> = {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    }
    const retryAfter = upstream.headers.get('retry-after')
    if (retryAfter) headers['Retry-After'] = retryAfter
    res.writeHead(upstream.status, headers)
    res.end(text)
  }
}

/** `startBackend` installs the live listener here; the register route mounts dynamic paths. */
export function attachIngestMount(listener: IngestMount): void {
  mount = listener
}

/** Remove every forwarding route and detach the listener. */
export function detachIngestMount(): void {
  for (const entry of routes.values()) entry.dispose()
  routes.clear()
  mount = null
}

/**
 * Mount `path` on the serve listener and forward requests to `targetUrl`.
 * A loopback-only target prevents the admin server from becoming an open proxy.
 */
export function registerIngestForwarder(input: RegisterIngestInput): {
  path: string
  runId: string
  targetUrl: string
} {
  if (!mount) throw new Error('no mt serve listener is active in this process')
  validatePath(input.path)
  const target = validateTargetUrl(input.targetUrl)

  const previous = routes.get(input.path)
  previous?.dispose()

  const dispose = mount.addRoute(input.path, forwarder(target))
  routes.set(input.path, {
    path: input.path,
    runId: input.runId,
    targetUrl: input.targetUrl,
    dispose,
  })
  return { path: input.path, runId: input.runId, targetUrl: input.targetUrl }
}

/** Remove one forwarding route (child shutdown). Returns whether it existed. */
export function unregisterIngestForwarder(path: string): boolean {
  const entry = routes.get(path)
  if (!entry) return false
  entry.dispose()
  routes.delete(path)
  return true
}
