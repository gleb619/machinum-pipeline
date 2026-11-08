import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { formatLogLine } from '@mt/core'
import { createLimiter } from '../core/limiter.js'
import { createLruCache } from '../core/lru-cache.js'
import { errorMessage, nonNegativeInteger, positiveInteger } from '../core/values.js'
import { type BrowserTranslateEngine, createHeadlessGoogleEngine } from './browser-translate.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const DEFAULT_CONCURRENCY = 4
const DEFAULT_QUEUE_LIMIT = 32
const DEFAULT_CACHE_ENTRIES = 1000
const DEFAULT_CACHE_MAX_BYTES = 64 * 1024 * 1024
const MAX_BODY_BYTES = 10 * 1024 * 1024
const RETRY_AFTER_SECONDS = 1
const SERVER_VERSION = '0.1.0'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

const USAGE = `Usage: mt-browser-translate [options]

Start a long-lived browser-translation worker backed by headless Chrome.

Options:
  --host <host>           Bind host (default: ${DEFAULT_HOST})
  --port <n>              Listen port (default: ${DEFAULT_PORT}; 0 = ephemeral)
  --token <token>         Bearer token (default: MT_BROWSER_TRANSLATE_TOKEN)
  --token-file <path>     Read the bearer token from a file
  --chrome-path <path>    Chrome/Chromium executable
  --headless              Run Chrome headless (default)
  --headed                Run Chrome with a visible window
  --concurrency <n>       Max in-flight translations (default: ${DEFAULT_CONCURRENCY})
  --queue-limit <n>       Waiting request limit (default: ${DEFAULT_QUEUE_LIMIT})
  --cache-entries <n>     Server LRU size (default: ${DEFAULT_CACHE_ENTRIES}; 0 disables)
  --cache-max-bytes <n>   Server cache byte cap (default: ${DEFAULT_CACHE_MAX_BYTES})
  --help, -h              Show this help
  --version, -v           Show version

Endpoints:
  GET  /health            Health and cache/concurrency stats (no auth)
  POST /translate         { text, sourceLang?, targetLang, cache? } (bearer auth when set)
`

export interface BrowserTranslateServerStats {
  requests: number
  cacheHits: number
  cacheMisses: number
  active: number
  queued: number
}

export interface BrowserTranslateServerOptions {
  host?: string
  port?: number
  token?: string
  chromePath?: string
  headless?: boolean
  timeoutMs?: number
  concurrency?: number
  queueLimit?: number
  cacheEntries?: number
  cacheMaxBytes?: number
  engine?: BrowserTranslateEngine
  log?: (line: string) => void
}

export interface BrowserTranslateServer {
  readonly url: string
  readonly host: string
  readonly port: number
  readonly stats: BrowserTranslateServerStats
  close(): Promise<void>
}

export interface BrowserTranslateServerArgs {
  host: string
  port: number
  token?: string
  tokenFile?: string
  chromePath?: string
  headless: boolean
  concurrency: number
  queueLimit: number
  cacheEntries: number
  cacheMaxBytes: number
  help: boolean
  version: boolean
}

interface TranslateRequestBody {
  text: string
  sourceLang?: string
  targetLang: string
  cache?: boolean
}

interface TranslateResponseBody {
  translatedText: string
  engine: 'google-endpoint'
  model: 'google-translate-web'
  ms: number
  cached: boolean
}

type JsonRecord = Record<string, unknown>

function tokenMatches(given: string, expected: string): boolean {
  const actual = Buffer.from(given, 'utf8')
  const wanted = Buffer.from(expected, 'utf8')
  const length = Math.max(actual.length, wanted.length)
  const paddedActual = Buffer.alloc(length)
  const paddedWanted = Buffer.alloc(length)
  actual.copy(paddedActual)
  wanted.copy(paddedWanted)
  return timingSafeEqual(paddedActual, paddedWanted) && actual.length === wanted.length
}

function normalizeHost(host: string): string {
  return host.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(host))
}

function hostForUrl(host: string): string {
  const normalized = normalizeHost(host)
  return normalized.includes(':') ? `[${normalized}]` : normalized
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTranslateBody(value: unknown): TranslateRequestBody | string {
  if (!isRecord(value)) return 'request body must be a JSON object'

  const { text, sourceLang, targetLang, cache } = value
  if (typeof text !== 'string') return 'text must be a string'
  if (typeof targetLang !== 'string' || !targetLang.trim()) {
    return 'targetLang must be a non-empty string'
  }
  if (sourceLang !== undefined && typeof sourceLang !== 'string') {
    return 'sourceLang must be a string'
  }
  if (cache !== undefined && typeof cache !== 'boolean') {
    return 'cache must be a boolean'
  }

  return {
    text,
    targetLang: targetLang.trim(),
    ...(sourceLang !== undefined ? { sourceLang: sourceLang.trim() || 'auto' } : {}),
    ...(cache !== undefined ? { cache } : {}),
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.writableEnded || response.destroyed) return
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  })
  response.end(JSON.stringify(body))
}

async function readBody(request: IncomingMessage): Promise<{ tooLarge: boolean; body: string }> {
  const chunks: Buffer[] = []
  let bytes = 0
  let tooLarge = false

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (tooLarge || bytes > MAX_BODY_BYTES) {
      tooLarge = true
      continue
    }
    chunks.push(buffer)
  }

  return { tooLarge, body: tooLarge ? '' : Buffer.concat(chunks).toString('utf8') }
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]?.trim() || undefined
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true
  return /timed?\s*out|timeout/i.test(error.message)
}

function cacheKey(body: TranslateRequestBody): string {
  return JSON.stringify([body.sourceLang ?? 'auto', body.targetLang, body.text])
}

function parseNumberFlag(name: string, value: string, min: number, max?: number): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`
    throw new Error(`${name} must be an integer ${range}`)
  }
  return parsed
}

function optionValue(
  args: readonly string[],
  index: number,
  name: string,
  inline: string | undefined,
): { value: string; next: number } {
  if (inline !== undefined) return { value: inline, next: index }
  const value = args[index + 1]
  if (value === undefined) throw new Error(`Missing value for ${name}`)
  return { value, next: index + 1 }
}

function defaults(): BrowserTranslateServerArgs {
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    headless: true,
    concurrency: DEFAULT_CONCURRENCY,
    queueLimit: DEFAULT_QUEUE_LIMIT,
    cacheEntries: DEFAULT_CACHE_ENTRIES,
    cacheMaxBytes: DEFAULT_CACHE_MAX_BYTES,
    help: false,
    version: false,
  }
}

/** Parse worker CLI flags. Help/version win over every other flag. */
export function parseBrowserTranslateServerArgs(
  argv: readonly string[],
): BrowserTranslateServerArgs {
  const wantedHelp = argv.includes('--help') || argv.includes('-h')
  const wantedVersion = argv.includes('--version') || argv.includes('-v')
  if (wantedHelp || wantedVersion) {
    return { ...defaults(), help: wantedHelp, version: wantedVersion }
  }

  const parsed = defaults()
  parsed.token = process.env.MT_BROWSER_TRANSLATE_TOKEN?.trim() || undefined
  let token: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    const inline = equals === -1 ? undefined : arg.slice(equals + 1)

    if (name === '--host') {
      const value = optionValue(argv, i, name, inline)
      parsed.host = value.value
      i = value.next
    } else if (name === '--port') {
      const value = optionValue(argv, i, name, inline)
      parsed.port = parseNumberFlag('--port', value.value, 0, 65_535)
      i = value.next
    } else if (name === '--token') {
      const value = optionValue(argv, i, name, inline)
      token = value.value
      i = value.next
    } else if (name === '--token-file') {
      const value = optionValue(argv, i, name, inline)
      parsed.tokenFile = value.value
      i = value.next
    } else if (name === '--chrome-path') {
      const value = optionValue(argv, i, name, inline)
      parsed.chromePath = value.value
      i = value.next
    } else if (name === '--headless') {
      parsed.headless = true
    } else if (name === '--headed') {
      parsed.headless = false
    } else if (name === '--concurrency') {
      const value = optionValue(argv, i, name, inline)
      parsed.concurrency = parseNumberFlag('--concurrency', value.value, 1)
      i = value.next
    } else if (name === '--queue-limit') {
      const value = optionValue(argv, i, name, inline)
      parsed.queueLimit = parseNumberFlag('--queue-limit', value.value, 0)
      i = value.next
    } else if (name === '--cache-entries') {
      const value = optionValue(argv, i, name, inline)
      parsed.cacheEntries = parseNumberFlag('--cache-entries', value.value, 0)
      i = value.next
    } else if (name === '--cache-max-bytes') {
      const value = optionValue(argv, i, name, inline)
      parsed.cacheMaxBytes = parseNumberFlag('--cache-max-bytes', value.value, 0)
      i = value.next
    } else {
      throw new Error(`Unknown option: ${name}`)
    }
  }

  if (parsed.tokenFile) {
    if (token !== undefined) {
      throw new Error('Use either --token or --token-file, not both')
    }
    const fileToken = readFileSync(parsed.tokenFile, 'utf8').trim()
    if (!fileToken) throw new Error(`Token file is empty: ${parsed.tokenFile}`)
    token = fileToken
  }

  parsed.token = token?.trim() || parsed.token
  return parsed
}

/** Start a long-lived HTTP worker backed by one browser-translation engine. */
export async function startBrowserTranslateServer(
  options: BrowserTranslateServerOptions = {},
): Promise<BrowserTranslateServer> {
  const host = normalizeHost(options.host?.trim() || DEFAULT_HOST)
  const port = options.port === undefined ? DEFAULT_PORT : options.port
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`browser-translate server: invalid port ${port}`)
  }
  const token = options.token?.trim() || process.env.MT_BROWSER_TRANSLATE_TOKEN?.trim() || undefined
  if (!isLoopbackHost(host) && !token) {
    throw new Error(
      `browser-translate server: refusing to bind to ${host} without a token; set --token or MT_BROWSER_TRANSLATE_TOKEN`,
    )
  }

  const concurrency = positiveInteger(options.concurrency, DEFAULT_CONCURRENCY)
  const queueLimit = nonNegativeInteger(options.queueLimit, DEFAULT_QUEUE_LIMIT)
  const cacheEntries = nonNegativeInteger(options.cacheEntries, DEFAULT_CACHE_ENTRIES)
  const cacheMaxBytes = nonNegativeInteger(options.cacheMaxBytes, DEFAULT_CACHE_MAX_BYTES)
  const maxActiveUploads = concurrency + queueLimit
  const ownsEngine = options.engine === undefined
  const engine =
    options.engine ??
    createHeadlessGoogleEngine({
      chromePath: options.chromePath,
      headless: options.headless,
      timeoutMs: options.timeoutMs,
    })

  const stats: BrowserTranslateServerStats = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    active: 0,
    queued: 0,
  }
  const cache = createLruCache({ maxEntries: cacheEntries, maxBytes: cacheMaxBytes })
  const pending = new Set<Promise<void>>()
  let activeUploads = 0
  let closing = false
  let closePromise: Promise<void> | undefined

  const limiter = createLimiter({
    concurrency,
    queueLimit,
    onChange: (active, queued) => {
      stats.active = active
      stats.queued = queued
    },
  })

  const handleHealth = (response: ServerResponse): void => {
    sendJson(response, 200, {
      status: 'ok',
      engine: 'google-endpoint',
      cache: {
        entries: cache.size,
        bytes: cache.bytes,
        hits: stats.cacheHits,
        misses: stats.cacheMisses,
      },
      active: stats.active,
      queued: stats.queued,
    })
  }

  const handleTranslate = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    stats.requests++
    if (token) {
      const given = bearerToken(request)
      if (!given || !tokenMatches(given, token)) {
        sendJson(response, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
        return
      }
    }
    if (closing) {
      sendJson(response, 503, { error: 'Server is shutting down' }, { 'Retry-After': '1' })
      return
    }

    if (activeUploads >= maxActiveUploads) {
      sendJson(
        response,
        429,
        { error: 'Too many uploads in flight' },
        { 'Retry-After': String(RETRY_AFTER_SECONDS) },
      )
      return
    }

    activeUploads++
    let bodyRead: { tooLarge: boolean; body: string } | undefined
    try {
      const declaredLength = request.headers['content-length']
      if (typeof declaredLength === 'string') {
        const declared = Number(declaredLength)
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          response.once('finish', () => request.destroy())
          sendJson(response, 413, { error: 'Payload too large' }, { Connection: 'close' })
          return
        }
      }
      bodyRead = await readBody(request)
    } finally {
      activeUploads--
    }
    if (!bodyRead) return
    if (bodyRead.tooLarge) {
      sendJson(response, 413, { error: 'Payload too large' })
      return
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(bodyRead.body) as unknown
    } catch {
      sendJson(response, 400, { error: 'Invalid JSON' })
      return
    }

    const body = parseTranslateBody(parsedJson)
    if (typeof body === 'string') {
      sendJson(response, 400, { error: body })
      return
    }

    const key = cacheKey(body)
    if (body.cache !== false) {
      const cached = cache.get(key)
      if (cached !== undefined) {
        stats.cacheHits++
        const hit: TranslateResponseBody = {
          translatedText: cached,
          engine: 'google-endpoint',
          model: 'google-translate-web',
          ms: 0,
          cached: true,
        }
        sendJson(response, 200, hit)
        return
      }
    }
    stats.cacheMisses++

    const admitted = await limiter.acquire()
    if (!admitted) {
      sendJson(
        response,
        429,
        { error: 'Translate queue full' },
        { 'Retry-After': String(RETRY_AFTER_SECONDS) },
      )
      return
    }

    try {
      const started = performance.now()
      let translatedText: string
      try {
        translatedText = await engine.translate({
          text: body.text,
          sourceLang: body.sourceLang ?? 'auto',
          targetLang: body.targetLang,
        })
      } catch (error) {
        const status = isTimeoutError(error) ? 504 : 502
        const prefix = status === 504 ? 'Translation timed out' : 'Translation failed'
        sendJson(response, status, { error: `${prefix}: ${errorMessage(error)}` })
        return
      }
      if (translatedText.trim() === '') {
        sendJson(response, 502, { error: 'Translation returned empty text' })
        return
      }

      const ms = Math.max(0, Math.round(performance.now() - started))
      cache.set(key, translatedText)
      const result: TranslateResponseBody = {
        translatedText,
        engine: 'google-endpoint',
        model: 'google-translate-web',
        ms,
        cached: false,
      }
      sendJson(response, 200, result)
    } finally {
      limiter.release()
    }
  }

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const method = request.method ?? 'GET'
    const pathname = (request.url ?? '').split('?')[0] ?? ''

    if (method === 'GET' && pathname === '/health') {
      handleHealth(response)
      return
    }
    if (method === 'POST' && pathname === '/translate') {
      await handleTranslate(request, response)
      return
    }
    sendJson(response, 404, { error: 'Not found' })
  }

  const httpServer: Server = createServer((request, response) => {
    const operation = handleRequest(request, response).catch((error: unknown) => {
      sendJson(response, 500, { error: `Internal server error: ${errorMessage(error)}` })
    })
    pending.add(operation)
    void operation.finally(() => {
      pending.delete(operation)
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        httpServer.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        httpServer.off('error', onError)
        resolve()
      }
      httpServer.once('error', onError)
      httpServer.once('listening', onListening)
      httpServer.listen(port, host)
    })
  } catch (error) {
    if (!options.engine) {
      try {
        await engine.close?.()
      } catch {
        // Preserve the original listen error.
      }
    }
    throw error
  }

  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    httpServer.close()
    throw new Error('browser-translate server: failed to resolve the listening address')
  }
  const addressInfo: AddressInfo = address
  const url = `http://${hostForUrl(host)}:${addressInfo.port}`
  options.log?.(formatLogLine('info', `mt-browser-translate listening on ${url}`))

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closing = true
    closePromise = (async () => {
      const stopped = new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
      })

      await Promise.allSettled([...pending])
      try {
        if (ownsEngine) await engine.close?.()
      } finally {
        httpServer.closeAllConnections()
        await stopped
      }
    })()
    return closePromise
  }

  return {
    url,
    host,
    port: addressInfo.port,
    stats,
    close,
  }
}

/** Run the worker CLI. Help/version print and return; otherwise the process stays alive. */
export async function runBrowserTranslateServerCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseBrowserTranslateServerArgs(argv)
  if (args.help) {
    console.log(USAGE)
    return
  }
  if (args.version) {
    console.log(`mt-browser-translate ${SERVER_VERSION}`)
    return
  }

  let server: BrowserTranslateServer | undefined
  let shuttingDown = false
  let closeStarted = false
  const closeAndExit = (started: BrowserTranslateServer): void => {
    if (closeStarted) return
    closeStarted = true
    started.close().then(
      () => process.exit(0),
      (error: unknown) => {
        const message = errorMessage(error)
        console.error(formatLogLine('error', `mt-browser-translate shutdown failed: ${message}`))
        process.exit(1)
      },
    )
  }
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    if (server) closeAndExit(server)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  try {
    server = await startBrowserTranslateServer({
      host: args.host,
      port: args.port,
      token: args.token,
      chromePath: args.chromePath,
      headless: args.headless,
      concurrency: args.concurrency,
      queueLimit: args.queueLimit,
      cacheEntries: args.cacheEntries,
      cacheMaxBytes: args.cacheMaxBytes,
      log: (line) => console.log(line),
    })
  } catch (error) {
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    throw error
  }

  if (shuttingDown && server) closeAndExit(server)
}
