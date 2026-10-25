import { type H3Event, createError, getHeader } from 'h3'
import type { OpenRouterClient, OpenRouterPool } from './openrouter-pool.js'
import { redact } from './redact.js'
import type { Upstream } from './upstream.js'

export function upstreamLabel(upstream: Upstream): string {
  return upstream.kind === 'openrouter' ? 'OpenRouter' : upstream.name
}

function forward(
  event: H3Event,
  upstream: Upstream,
  client: OpenRouterClient,
  body: string,
): Promise<Response> {
  // Strict allowlist: the client's Authorization / x-api-key / cookie / router token are never
  // forwarded; upstream auth comes only from the registry.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // Keyless upstreams (ollama) get no Authorization header at all.
  if (client.apiKey) headers.Authorization = `Bearer ${client.apiKey}`
  const referer = getHeader(event, 'http-referer')
  const title = getHeader(event, 'x-title')
  if (upstream.kind === 'openrouter') {
    headers['HTTP-Referer'] = referer ?? ''
    headers['X-Title'] = title ?? ''
  } else {
    if (referer) headers['HTTP-Referer'] = referer
    if (title) headers['X-Title'] = title
  }
  Object.assign(headers, upstream.headers)
  return fetch(`${client.apiUrl}/chat/completions`, { method: 'POST', headers, body })
}

/**
 * Shared chat/completions forward: picks a client, retries once on 429 with the next client, maps
 * 402 / non-2xx to H3 errors (upstream bodies redacted). Returns the OK upstream response.
 * `pool` overrides the upstream's own pool (per-request key override on the default upstream).
 */
export async function callUpstream(
  event: H3Event,
  upstream: Upstream,
  upstreamModel: string,
  payload: string,
  pool: OpenRouterPool = upstream.getPool(),
): Promise<Response> {
  const noClients = () =>
    createError({
      statusCode: 503,
      statusMessage: `No available ${upstreamLabel(upstream)} clients`,
    })

  const client = pool.getAvailableClient(upstreamModel)
  if (!client) throw noClients()

  let used = client
  let response = await forward(event, upstream, used, payload)

  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after')
    const ms = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 60_000
    pool.handleRateLimitError(used, ms)
    const next = pool.getAvailableClient(upstreamModel)
    if (!next) throw noClients()
    used = next
    response = await forward(event, upstream, used, payload)
    if (response.status === 429) {
      pool.handleRateLimitError(used, ms)
      throw createError({
        statusCode: 429,
        statusMessage: `Rate limited by ${upstreamLabel(upstream)}`,
      })
    }
  }

  if (response.status === 402) {
    pool.handle402Error(used)
    throw createError({ statusCode: 402, statusMessage: 'Payment required / DDoS block' })
  }

  if (!response.ok) {
    const errorText = await response.text()
    throw createError({
      statusCode: 502,
      statusMessage: `${upstreamLabel(upstream)} error: ${response.status} ${redact(errorText)}`,
    })
  }

  return response
}
