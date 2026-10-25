import { Readable } from 'node:stream'

import { createError, defineEventHandler, getHeader, readBody, sendStream } from 'h3'
import { isMockMode } from '../../../plugins/mock-mode.js'
import { clientIdFrom } from '../../../utils/client-id.js'
import { logCall } from '../../../utils/cost-tracker.js'
import { redactError } from '../../../utils/redact.js'
import { callUpstream } from '../../../utils/upstream-call.js'
import { getUpstreamRegistry } from '../../../utils/upstream.js'

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

  const registry = getUpstreamRegistry()
  const requested =
    (body.model as string | undefined) ?? registry.defaultUpstream.defaultModel ?? 'unknown'
  const { upstream, upstreamModel } = registry.resolve(requested)
  const runId = getHeader(event, 'x-mt-run-id') ?? null
  const stepId = getHeader(event, 'x-mt-step-id') ?? null

  // Only touch the model field when routing changed it or a default filled it in.
  const forwarded = upstreamModel !== body.model ? { ...body, model: upstreamModel } : body
  const payload = JSON.stringify(forwarded)

  try {
    const response = await callUpstream(event, upstream, upstreamModel, payload)

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
      {
        upstream: upstream.name,
        free: upstream.kind !== 'openrouter',
        client: clientIdFrom(event),
      },
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
