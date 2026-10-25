import { Readable } from 'node:stream'

import { type H3Event, createError, defineEventHandler, getHeader, readBody, sendStream } from 'h3'
import { isMockMode } from '../../../plugins/mock-mode.js'
import { logCall } from '../../../utils/cost-tracker.js'
import type { OpenRouterClient } from '../../../utils/openrouter-pool.js'
import { redact, redactError } from '../../../utils/redact.js'
import { type Upstream, getUpstreamRegistry } from '../../../utils/upstream.js'

// biome-ignore lint/suspicious/noExplicitAny: Node.js stream type incompatibility
function toNodeReadable(stream: ReadableStream<any> | null): Readable {
  if (!stream) {
    throw createError({ statusCode: 502, statusMessage: 'Empty response body' })
  }
  // @ts-expect-error - Node.js stream type incompatibility
  return Readable.fromWeb(stream)
}

const MOCK_RESPONSE = {
  id: 'mock-1',
  choices: [
    {
      message: {
        role: 'assistant' as const,
        content: 'Mock response from Mt Router',
      },
    },
  ],
  usage: {
    prompt_tokens: 0,
    completion_tokens: 0,
  },
}

interface OpenRouterResponse {
  id?: string
  model?: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  [key: string]: unknown
}

function label(upstream: Upstream): string {
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

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event)

  if (isMockMode()) {
    return MOCK_RESPONSE
  }

  const registry = getUpstreamRegistry()
  const requested =
    (body.model as string | undefined) ?? registry.defaultUpstream.defaultModel ?? 'unknown'
  const { upstream, upstreamModel } = registry.resolve(requested)
  const pool = upstream.getPool()
  const noClients = () =>
    createError({ statusCode: 503, statusMessage: `No available ${label(upstream)} clients` })

  const client = pool.getAvailableClient(upstreamModel)
  if (!client) throw noClients()

  const runId = getHeader(event, 'x-mt-run-id') ?? null
  const stepId = getHeader(event, 'x-mt-step-id') ?? null

  // Only touch the model field when routing changed it or a default filled it in.
  const forwarded = upstreamModel !== body.model ? { ...body, model: upstreamModel } : body
  const payload = JSON.stringify(forwarded)

  try {
    let used = client
    let response = await forward(event, upstream, used, payload)
    const retryMs = (r: Response) => {
      const retryAfter = r.headers.get('retry-after')
      return retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 60_000
    }

    if (response.status === 429) {
      const ms = retryMs(response)
      pool.handleRateLimitError(used, ms)
      const next = pool.getAvailableClient(upstreamModel)
      if (!next) throw noClients()
      used = next
      response = await forward(event, upstream, used, payload)
      if (response.status === 429) {
        pool.handleRateLimitError(used, ms)
        throw createError({
          statusCode: 429,
          statusMessage: `Rate limited by ${label(upstream)}`,
        })
      }
    }

    if (response.status === 402) {
      pool.handle402Error(used)
      throw createError({
        statusCode: 402,
        statusMessage: 'Payment required / DDoS block',
      })
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw createError({
        statusCode: 502,
        statusMessage: `${label(upstream)} error: ${response.status} ${redact(errorText)}`,
      })
    }

    if (body.stream === true) {
      event.node.res.setHeader('Content-Type', 'text/event-stream')
      event.node.res.setHeader('Cache-Control', 'no-cache')
      event.node.res.setHeader('Transfer-Encoding', 'chunked')
      return sendStream(event, toNodeReadable(response.body))
    }

    const data = (await response.json()) as OpenRouterResponse
    const promptTokens = data.usage?.prompt_tokens ?? 0
    const completionTokens = data.usage?.completion_tokens ?? 0

    void logCall(
      runId,
      stepId,
      requested,
      { promptTokens, completionTokens },
      { upstream: upstream.name, free: upstream.kind !== 'openrouter' },
    )

    return data
  } catch (err) {
    if (err instanceof Error && 'statusCode' in err) throw err
    throw createError({
      statusCode: 502,
      statusMessage: `Proxy error: ${redactError(err)}`,
    })
  }
})
