import { Readable } from 'node:stream'

import { createError, defineEventHandler, getHeader, readBody, sendStream } from 'h3'
import { isMockMode } from '../../../plugins/mock-mode.js'
import { logCall } from '../../../utils/cost-tracker.js'
import { poolSupplier } from '../../../utils/openrouter-pool-supplier.js'

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

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event)

  if (isMockMode()) {
    return MOCK_RESPONSE
  }

  const pool = poolSupplier.getPool()
  const model = (body.model as string) ?? 'unknown'
  const client = pool.getAvailableClient(model)

  if (!client) {
    throw createError({
      statusCode: 503,
      statusMessage: 'No available OpenRouter clients',
    })
  }

  const runId = getHeader(event, 'x-mt-run-id') ?? null
  const stepId = getHeader(event, 'x-mt-step-id') ?? null

  try {
    const upstreamResponse = await fetch(`${client.apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${client.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': getHeader(event, 'http-referer') ?? '',
        'X-Title': getHeader(event, 'x-title') ?? '',
      },
      body: JSON.stringify(body),
    })

    if (upstreamResponse.status === 429) {
      const retryAfter = upstreamResponse.headers.get('retry-after')
      const retryMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 60_000
      pool.handleRateLimitError(client, retryMs)

      const nextClient = pool.getAvailableClient(model)
      if (!nextClient) {
        throw createError({
          statusCode: 503,
          statusMessage: 'No available OpenRouter clients',
        })
      }

      const retryResponse = await fetch(`${nextClient.apiUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${nextClient.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': getHeader(event, 'http-referer') ?? '',
          'X-Title': getHeader(event, 'x-title') ?? '',
        },
        body: JSON.stringify(body),
      })

      if (retryResponse.status === 429) {
        pool.handleRateLimitError(nextClient, retryMs)
        throw createError({
          statusCode: 429,
          statusMessage: 'Rate limited by OpenRouter',
        })
      }

      if (retryResponse.status === 402) {
        pool.handle402Error(nextClient)
        throw createError({
          statusCode: 402,
          statusMessage: 'Payment required / DDoS block',
        })
      }

      if (!retryResponse.ok) {
        const errorText = await retryResponse.text()
        throw createError({
          statusCode: 502,
          statusMessage: `OpenRouter error: ${retryResponse.status} ${errorText}`,
        })
      }

      if (body.stream === true) {
        event.node.res.setHeader('Content-Type', 'text/event-stream')
        event.node.res.setHeader('Cache-Control', 'no-cache')
        event.node.res.setHeader('Transfer-Encoding', 'chunked')
        return sendStream(event, toNodeReadable(retryResponse.body))
      }

      const data = (await retryResponse.json()) as OpenRouterResponse
      const promptTokens = data.usage?.prompt_tokens ?? 0
      const completionTokens = data.usage?.completion_tokens ?? 0

      void logCall(runId, stepId, model, { promptTokens, completionTokens })

      return data
    }

    if (upstreamResponse.status === 402) {
      pool.handle402Error(client)
      throw createError({
        statusCode: 402,
        statusMessage: 'Payment required / DDoS block',
      })
    }

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text()
      throw createError({
        statusCode: 502,
        statusMessage: `OpenRouter error: ${upstreamResponse.status} ${errorText}`,
      })
    }

    if (body.stream === true) {
      event.node.res.setHeader('Content-Type', 'text/event-stream')
      event.node.res.setHeader('Cache-Control', 'no-cache')
      event.node.res.setHeader('Transfer-Encoding', 'chunked')
      return sendStream(event, toNodeReadable(upstreamResponse.body))
    }

    const data = (await upstreamResponse.json()) as OpenRouterResponse

    const promptTokens = data.usage?.prompt_tokens ?? 0
    const completionTokens = data.usage?.completion_tokens ?? 0

    void logCall(runId, stepId, model, { promptTokens, completionTokens })

    return data
  } catch (err) {
    if (err instanceof Error && 'statusCode' in err) throw err
    throw createError({
      statusCode: 502,
      statusMessage: `Proxy error: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
})
