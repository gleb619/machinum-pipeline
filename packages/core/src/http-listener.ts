import {
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
  createServer,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { createConsoleLogger } from './logging.js'
import type { ListenerLease } from './types.js'

/**
 * Handler mounted on a shared HTTP listener. The registry dispatches by exact pathname;
 * the `'*'` route is the fallback used by `mt serve` to mount its h3 app.
 */
export type HttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** Creates the underlying `http.Server`. It must not attach its own `request` handler. */
export type ListenerFactory = () => Server

interface RouteEntry {
  readonly path: string
  readonly handler: HttpRouteHandler
  readonly owner: symbol
}

interface ListenerEntry {
  key: string
  host: string
  port: number
  readonly server: Server
  refs: number
  readonly routes: Map<string, RouteEntry>
}

const FALLBACK_ROUTE = '*'
const logger = createConsoleLogger()

/** Live listeners keyed by `<host>:<actual-port>`. */
const listeners = new Map<string, ListenerEntry>()
/** In-flight listen attempts, so concurrent acquires share one bind. */
const pending = new Map<string, Promise<ListenerEntry>>()

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function normalizeHost(host: string): string {
  const trimmed = stripBrackets(host.trim().toLowerCase())
  if (trimmed === '' || trimmed === 'localhost') return '127.0.0.1'
  if (trimmed === 'ip6-localhost') return '::1'
  return trimmed
}

function isLoopbackHost(host: string): boolean {
  return host === '::1' || host === '127.0.0.1' || host.startsWith('127.')
}

function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === ''
}

/**
 * Host compatibility rule: identical hosts share; a listener bound to a wildcard
 * interface also covers a loopback request. Explicit different interfaces stay separate.
 */
export function hostsShareListener(existingHost: string, requestedHost: string): boolean {
  const existing = normalizeHost(existingHost)
  const requested = normalizeHost(requestedHost)
  if (existing === requested) return true
  return isWildcardHost(existing) && isLoopbackHost(requested)
}

function keyFor(host: string, port: number): string {
  return `${host}:${port}`
}

function findListener(host: string, port: number): ListenerEntry | undefined {
  if (port === 0) return undefined
  let wildcardMatch: ListenerEntry | undefined
  for (const entry of listeners.values()) {
    if (entry.port !== port) continue
    if (entry.host === host) return entry
    if (!wildcardMatch && hostsShareListener(entry.host, host)) wildcardMatch = entry
  }
  return wildcardMatch
}

function listenError(error: unknown, host: string, port: number): Error {
  const code = (error as { code?: string } | null)?.code
  const address = `${host}:${port}`
  if (code === 'EADDRINUSE') {
    return Object.assign(
      new Error(
        `HTTP listener ${address} is already in use (EADDRINUSE); another process owns this port`,
      ),
      { code, cause: error },
    )
  }
  if (code === 'EACCES') {
    return Object.assign(new Error(`HTTP listener ${address} is not permitted (EACCES)`), {
      code,
      cause: error,
    })
  }
  return error instanceof Error ? error : new Error(String(error))
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function failHandler(
  entry: ListenerEntry,
  path: string,
  error: unknown,
  res: ServerResponse,
): void {
  const message = error instanceof Error ? error.message : String(error)
  logger.error('HTTP route handler failed', {
    host: entry.host,
    port: entry.port,
    path,
    error: message,
  })
  if (!res.writableEnded) sendJson(res, 500, { error: 'Internal server error' })
}

function dispatch(entry: ListenerEntry, req: IncomingMessage, res: ServerResponse): void {
  const rawUrl = req.url ?? '/'
  const queryIndex = rawUrl.indexOf('?')
  const pathname = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl
  const route = entry.routes.get(pathname) ?? entry.routes.get(FALLBACK_ROUTE)
  if (!route) {
    sendJson(res, 404, { error: 'Not found' })
    return
  }
  try {
    const result = route.handler(req, res)
    if (result) result.catch((error: unknown) => failHandler(entry, pathname, error, res))
  } catch (error) {
    failHandler(entry, pathname, error, res)
  }
}

function normalizeRoutePath(path: string): string {
  const trimmed = path.trim()
  if (trimmed === FALLBACK_ROUTE) return FALLBACK_ROUTE
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  if (withSlash.includes('?')) throw new Error(`HTTP route '${path}' must not contain a query`)
  return withSlash
}

function addRoute(
  entry: ListenerEntry,
  owner: symbol,
  path: string,
  handler: HttpRouteHandler,
): () => void {
  const normalized = normalizeRoutePath(path)
  if (entry.routes.has(normalized)) {
    throw new Error(
      `HTTP route '${normalized}' is already registered on ${entry.host}:${entry.port}`,
    )
  }
  const route: RouteEntry = { path: normalized, handler, owner }
  entry.routes.set(normalized, route)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (entry.routes.get(normalized) === route) entry.routes.delete(normalized)
  }
}

async function createEntry(
  host: string,
  port: number,
  factory: ListenerFactory | undefined,
): Promise<ListenerEntry> {
  const server = factory ? factory() : createServer()
  const entry: ListenerEntry = {
    key: '',
    host,
    port,
    server,
    refs: 0,
    routes: new Map<string, RouteEntry>(),
  }
  const listener: RequestListener = (req, res) => dispatch(entry, req, res)
  server.on('request', listener)

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: unknown) => {
        server.removeListener('error', onError)
        rejectListen(listenError(error, host, port))
      }
      server.once('error', onError)
      server.listen(port, host, () => {
        server.removeListener('error', onError)
        resolveListen()
      })
    })
  } catch (error) {
    server.removeListener('request', listener)
    if (server.listening) server.close()
    throw error
  }

  const address = server.address() as AddressInfo
  entry.port = address.port
  entry.key = keyFor(host, entry.port)
  return entry
}

async function closeEntry(entry: ListenerEntry): Promise<void> {
  listeners.delete(entry.key)
  entry.routes.clear()
  if (!entry.server.listening) return
  entry.server.closeAllConnections?.()
  await new Promise<void>((resolveClose) => {
    entry.server.close(() => resolveClose())
  })
}

function leaseFor(entry: ListenerEntry): ListenerLease {
  entry.refs += 1
  const owner = Symbol('http-listener-lease')
  const owned = new Set<() => void>()
  let released = false

  return {
    server: entry.server,
    host: entry.host,
    port: entry.port,
    shared: entry.refs > 1,
    addRoute(path: string, handler: HttpRouteHandler): () => void {
      const dispose = addRoute(entry, owner, path, handler)
      owned.add(dispose)
      return () => {
        owned.delete(dispose)
        dispose()
      }
    },
    async release(): Promise<void> {
      if (released) return
      released = true
      for (const dispose of owned) dispose()
      owned.clear()
      entry.refs -= 1
      if (entry.refs <= 0) await closeEntry(entry)
    },
  }
}

/**
 * Acquire a refcounted HTTP listener for `host:port`.
 *
 * Several sources/targets in one process share one `http.Server`; it closes only when
 * the last lease releases. `port: 0` always creates a fresh listener (the actual port
 * is on the returned lease). A foreign process on the port rejects with an
 * `EADDRINUSE` error naming `host:port`.
 */
export async function acquireListener(
  host: string,
  port: number,
  factory?: ListenerFactory,
): Promise<ListenerLease> {
  const normalizedHost = normalizeHost(host)

  const existing = findListener(normalizedHost, port)
  if (existing) return leaseFor(existing)

  const pendingKey = keyFor(normalizedHost, port)
  if (port !== 0) {
    const inFlight = pending.get(pendingKey)
    if (inFlight) return leaseFor(await inFlight)
  }

  const creation = createEntry(normalizedHost, port, factory)
  if (port !== 0) pending.set(pendingKey, creation)
  try {
    const entry = await creation
    listeners.set(entry.key, entry)
    return leaseFor(entry)
  } finally {
    if (port !== 0) pending.delete(pendingKey)
  }
}
