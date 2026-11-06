import type { Exchange, ParsedUri, RetryPolicy, Target, TargetContext } from '@mt/core'
import { annotate, parseRetryAfterMs, registry, waypoint, withRetry } from '@mt/core'

/**
 * Built-in HTTP Target — sends envelopes to an HTTP endpoint (client role).
 *
 * Scheme: `http://` / `https://`. The `hs://` shorthand stays source-only, so the role is
 * positional: `.from('http://…')` still listens, `.to('http://…')` sends.
 *
 * Query options (all optional):
 *   - `method`       HTTP verb — `POST` (default), `PUT`, `PATCH`, `DELETE`; `GET`/`HEAD` are rejected
 *   - `bearer`       name of an environment variable or vault entry holding the token
 *   - `timeoutMs`    per-request timeout (default 30000)
 *   - `retries`      retries for network errors, 429 and 5xx (default 3)
 *   - `batch`        `true`: one request per batch exchange, body carries `items[]`
 *   - `contentType`  `json` (default, full exchange), `item` (payload only), `text`
 *   - `header.<Name>` extra static header
 *
 * The response body is discarded (terminal target): 2xx means "accepted". A non-2xx status
 * fails the item — 429 and 5xx are retried with backoff (honouring `Retry-After`), every other
 * status fails at once.
 *
 * `checkpoint()` counts the 2xx-acked exchanges, so a crash resume replays the unacked ones
 * (at-least-once delivery; `X-MT-Exchange-Id` is the idempotency key).
 */

/** Default per-request timeout in ms. */
const DEFAULT_TIMEOUT_MS = 30_000
/** Default number of retries for network errors, 429 and 5xx. */
const DEFAULT_RETRIES = 3
/** Base backoff in ms — doubled per attempt (`exp` strategy). */
const DEFAULT_BACKOFF_MS = 100
/** Ceiling for a single wait (computed backoff or `Retry-After`). */
const DEFAULT_MAX_BACKOFF_MS = 30_000

/** Verbs the target may send. Body-less verbs are rejected at parse time. */
const ALLOWED_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const
type HttpTargetMethod = (typeof ALLOWED_METHODS)[number]

/** Body shapes the target may send. */
const ALLOWED_CONTENT_TYPES = ['json', 'item', 'text'] as const
type HttpTargetContentType = (typeof ALLOWED_CONTENT_TYPES)[number]

/** Query parameters the target consumes itself — never forwarded to the server. */
const CONTROL_PARAMS = new Set(['method', 'bearer', 'timeoutMs', 'retries', 'batch', 'contentType'])

/** Prefix of the static extra-header parameters (`header.X-Foo=bar`). */
const HEADER_PARAM_PREFIX = 'header.'

/** Shape of an environment variable name — the canonical `bearer=` reference. */
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/

/** RFC 7230 token characters — the legal characters in a header name. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** Replacement written over every masked value. */
const MASKED = '***'

/** Query keys whose value is a credential and must never reach a log line. */
const SECRET_QUERY_KEY_PATTERN =
  /(?:^|_)(?:api_?keys?|tokens?|secrets?|passwords?|passwd|credentials?|auth|authorization|bearer|access_key|client_secret|signature|sig|keys?)(?:_|$)/i

/** Free-form values that look like a credential and must never reach a log line. */
const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /^(?:Bearer|Basic|Digest)\s+\S+/i,
  /^(?:[0-9a-f]{32,}|[A-Za-z0-9+=_-]{32,})$/,
]

/**
 * Failure of one HTTP request. `retryable: false` marks the item as failed (no retry);
 * `retryAfterMs` overrides the computed backoff.
 */
export class HttpTargetError extends Error {
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly status?: number

  constructor(
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number; status?: number } = {},
  ) {
    super(message)
    this.name = 'HttpTargetError'
    this.retryable = options.retryable ?? true
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
    if (options.status !== undefined) this.status = options.status
  }
}

/** Resolved target configuration — everything the URI carried, parsed once. */
interface HttpTargetConfig {
  /** URL the request goes to — control parameters stripped. */
  requestUrl: string
  method: HttpTargetMethod
  contentType: HttpTargetContentType
  timeoutMs: number
  retries: number
  batch: boolean
  /** Name of the environment variable / vault entry holding the bearer token. */
  bearerRef?: string
  headers: Record<string, string>
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw)
  } catch {
    throw new Error(`http target: invalid URL '${raw}'`)
  }
}

function parseMethod(value: string | undefined): HttpTargetMethod {
  if (value === undefined) return 'POST'
  const method = value.toUpperCase()
  if ((ALLOWED_METHODS as readonly string[]).includes(method)) return method as HttpTargetMethod
  throw new Error(
    `http target: method '${value}' is not supported — expected one of: ${ALLOWED_METHODS.join(', ')}`,
  )
}

function parseContentType(value: string | undefined): HttpTargetContentType {
  if (value === undefined) return 'json'
  if ((ALLOWED_CONTENT_TYPES as readonly string[]).includes(value)) {
    return value as HttpTargetContentType
  }
  throw new Error(
    `http target: contentType '${value}' is not supported — expected one of: ${ALLOWED_CONTENT_TYPES.join(', ')}`,
  )
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`http target: ${name} must be a positive integer, got '${value}'`)
  }
  return parsed
}

function parseNonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`http target: ${name} must be an integer >= 0, got '${value}'`)
  }
  return parsed
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined) return false
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error(`http target: ${name} must be true or false, got '${value}'`)
}

/**
 * A `bearer=` value is a reference, never a secret. Env-var names are accepted as-is;
 * anything else that looks like a token (contains a dot or is longer than 64 chars) is
 * rejected instead of being sent as a credential.
 */
function assertBearerRef(value: string): void {
  if (ENV_NAME_PATTERN.test(value)) return
  if (value.includes('.') || value.length > 64) {
    throw new Error(
      'http target: bearer= must name an environment variable or vault entry (e.g. ' +
        'MT_REMOTE_TOKEN), not a secret value',
    )
  }
}

function parseHeaders(query: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith(HEADER_PARAM_PREFIX)) continue
    const name = key.slice(HEADER_PARAM_PREFIX.length)
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new Error(`http target: invalid header name '${name}' in '${key}'`)
    }
    headers[name] = value
  }
  return headers
}

/** The URL the request goes to — control parameters never reach the server. */
function buildRequestUrl(url: URL): string {
  const out = new URL(url.toString())
  for (const key of [...new Set([...out.searchParams.keys()])]) {
    if (CONTROL_PARAMS.has(key) || key.startsWith(HEADER_PARAM_PREFIX)) {
      out.searchParams.delete(key)
    }
  }
  return out.toString()
}

function parseConfig(uri: ParsedUri): HttpTargetConfig {
  const url = parseUrl(uri.raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `http target: unsupported scheme '${url.protocol.replace(':', '')}' — expected http:// or https://`,
    )
  }
  const bearerRef = uri.query.bearer
  if (bearerRef !== undefined) assertBearerRef(bearerRef)
  return {
    requestUrl: buildRequestUrl(url),
    method: parseMethod(uri.query.method),
    contentType: parseContentType(uri.query.contentType),
    timeoutMs: parsePositiveInt(uri.query.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs'),
    retries: parseNonNegativeInt(uri.query.retries, DEFAULT_RETRIES, 'retries'),
    batch: parseBoolean(uri.query.batch, 'batch'),
    ...(bearerRef === undefined ? {} : { bearerRef }),
    headers: parseHeaders(uri.query),
  }
}

/** True when a free-form value looks like a credential. */
function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))
}

/**
 * Copy of the URL with credential-looking query values masked. Log lines carry this copy,
 * never the raw URL.
 */
export function maskUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  for (const key of [...new Set([...parsed.searchParams.keys()])]) {
    const value = parsed.searchParams.get(key) ?? ''
    if (SECRET_QUERY_KEY_PATTERN.test(key) || looksLikeCredential(value)) {
      parsed.searchParams.set(key, MASKED)
    }
  }
  if (parsed.password) parsed.password = MASKED
  return parsed.toString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `Retry-After` is either a delay in seconds or an HTTP date (see core `parseRetryAfterMs`). */
function parseRetryAfter(value: string | null): number | undefined {
  const ms = parseRetryAfterMs(value)
  return ms === undefined ? undefined : Math.round(ms)
}

/** Render a payload as plain text: strings as-is, everything else as JSON. */
function renderText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (Array.isArray(payload)) return payload.map((entry) => renderText(entry)).join('\n')
  const serialized = JSON.stringify(payload)
  return serialized === undefined ? String(payload) : serialized
}

interface RequestBody {
  body: string
  contentType: string
}

/**
 * Body of one request.
 *
 * `json` (default) sends the exchange: `{ id, item | items, meta, variables }`. With
 * `batch=true` a batch exchange carries its members under `items` instead of `item`.
 * `item` sends the payload alone, `text` sends it as plain text.
 */
function buildBody(env: Exchange<unknown>, config: HttpTargetConfig): RequestBody {
  const batched = config.batch && env.items !== undefined
  const payload = batched ? env.items : env.item
  if (config.contentType === 'item') {
    return { body: JSON.stringify(payload), contentType: 'application/json' }
  }
  if (config.contentType === 'text') {
    return { body: renderText(payload), contentType: 'text/plain; charset=utf-8' }
  }
  const record: Record<string, unknown> = { id: env.id }
  if (batched) record.items = payload
  else record.item = payload
  record.meta = env.meta
  record.variables = env.variables
  return { body: JSON.stringify(record), contentType: 'application/json' }
}

/**
 * Resolve the bearer token from the environment (project env over `process.env`), then from
 * the vault. The reference names the secret — the value itself never appears in a URI.
 */
function resolveBearer(name: string, ctx: TargetContext): string {
  const env = { ...process.env, ...(ctx.run.global.env ?? {}) }
  const fromEnv = env[name]
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  const entry = ctx.run.global.vault?.entries?.[name]
  const key = entry?.apiKey ?? entry?.apiKeys?.[0]
  if (typeof key === 'string' && key !== '') return key
  throw new Error(
    `http target: bearer reference '${name}' not found in the environment or the vault`,
  )
}

/** One request attempt. 2xx succeeds; 429 and 5xx are retryable, everything else is fatal. */
async function attemptRequest(
  config: HttpTargetConfig,
  headers: Record<string, string>,
  body: string,
): Promise<number> {
  const masked = maskUrl(config.requestUrl)
  try {
    const response = await fetch(config.requestUrl, {
      method: config.method,
      headers,
      body,
      // A redirect to another origin is not followed — a 3xx is a failure.
      redirect: 'manual',
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    const status = response.status
    if (status >= 200 && status < 300) return status
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
    const retryable = status === 429 || status >= 500
    throw new HttpTargetError(
      `http target: ${config.method} ${masked} failed with status ${status}`,
      retryable ? { retryable, retryAfterMs, status } : { retryable, status },
    )
  } catch (cause) {
    if (cause instanceof HttpTargetError) throw cause
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError'
    throw new HttpTargetError(
      timedOut
        ? `http target: ${config.method} ${masked} timed out after ${config.timeoutMs}ms`
        : `http target: ${config.method} ${masked} failed: ${errorMessage(cause)}`,
    )
  }
}

/**
 * HTTP Target — sends every exchange to an HTTP endpoint.
 *
 * One request per exchange. A 2xx acks the exchange (and counts towards the checkpoint);
 * 429 and 5xx are retried with exponential backoff, honouring `Retry-After`; every other
 * non-2xx status fails the item at once.
 */
export function createHttpTarget<T>(uri: ParsedUri): Target<T> {
  const config = parseConfig(uri)
  let opened = false
  let bearer: string | undefined
  let acked = 0

  return {
    uri: uri.raw,

    async open(ctx: TargetContext): Promise<void> {
      bearer = config.bearerRef === undefined ? undefined : resolveBearer(config.bearerRef, ctx)
      opened = true
      acked = 0
      ctx.run.logger.info('http target opened', {
        url: maskUrl(config.requestUrl),
        method: config.method,
      })
    },

    async write(env: Exchange<T>, ctx: TargetContext): Promise<void> {
      if (!opened) {
        throw new Error('Target not opened. Call open() before write().')
      }
      const { body, contentType } = buildBody(env, config)
      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'X-MT-Exchange-Id': env.id,
        ...config.headers,
      }
      if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`

      const policy: RetryPolicy = {
        max: config.retries,
        backoffMs: DEFAULT_BACKOFF_MS,
        strategy: 'exp',
        maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
      }
      const masked = maskUrl(config.requestUrl)
      try {
        const status = await withRetry(
          () => attemptRequest(config, headers, body),
          policy,
          (error, attempt) => {
            ctx.run.logger.warn('http target retry', {
              url: masked,
              method: config.method,
              attempt: attempt + 1,
              error: errorMessage(error),
            })
          },
        )
        acked += 1
        ctx.run.logger.info('http target request', {
          url: masked,
          method: config.method,
          status,
          exchangeId: env.id,
        })
      } catch (error) {
        ctx.run.logger.error('http target request failed', {
          url: masked,
          method: config.method,
          error: errorMessage(error),
        })
        throw error
      }
    },

    async close(ctx: TargetContext): Promise<void> {
      if (!opened) return
      opened = false
      ctx.run.logger.info('http target closed', { acked })
    },

    async checkpoint(_ctx: TargetContext): Promise<number> {
      return acked
    },
  }
}

annotate(
  createHttpTarget,
  waypoint('WT003', {
    name: 'http target',
    description: 'Sends envelopes to an HTTP endpoint, one request per exchange.',
    meta: { schemes: ['http', 'https'], direction: 'target' },
  }),
)
// Register built-in HTTP target under both schemes — `hs://` stays source-only.
registry.registerTarget('http', createHttpTarget)
registry.registerTarget('https', createHttpTarget)
