import { createError, defineEventHandler, getHeader, readBody } from 'h3'
import { isMockMode } from '../../../plugins/mock-mode.js'
import { logCall } from '../../../utils/cost-tracker.js'

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

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw createError({
      statusCode: 500,
      statusMessage: 'OPENROUTER_API_KEY not configured',
    })
  }

  const runId = getHeader(event, 'x-mt-run-id') ?? null
  const stepId = getHeader(event, 'x-mt-step-id') ?? null

  try {
    const upstreamResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': getHeader(event, 'http-referer') ?? '',
        'X-Title': getHeader(event, 'x-title') ?? '',
      },
      body: JSON.stringify(body),
    })

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text()
      throw createError({
        statusCode: 502,
        statusMessage: `OpenRouter error: ${upstreamResponse.status} ${errorText}`,
      })
    }

    const data = (await upstreamResponse.json()) as OpenRouterResponse

    const model = (body.model as string) ?? data.model ?? 'unknown'
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
