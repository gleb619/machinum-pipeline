import { OpenRouterPool } from '@mt/tools'
import { createError, defineEventHandler, getHeader, getQuery, readBody } from 'h3'
import { isMockMode } from '../../plugins/mock-mode.js'
import { logCall } from '../../utils/cost-tracker.js'
import { poolSupplier } from '../../utils/openrouter-pool-supplier.js'

interface TranslateRequest {
  text: string | string[]
  sourceLang?: string
  targetLang: string
  model?: string
  apiKeys?: string[]
}

interface TranslateResponse {
  translatedText: string
  model: string
  tokens: number
}

interface BatchTranslateResponse {
  results: TranslateResponse[]
}

interface OpenRouterMessage {
  role: 'system' | 'user'
  content: string
}

interface OpenRouterChatRequest {
  model: string
  messages: OpenRouterMessage[]
}

interface OpenRouterChatResponse {
  id?: string
  model?: string
  choices?: Array<{
    message?: {
      role?: string
      content?: string
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function buildSystemPrompt(targetLang: string, sourceLang?: string): string {
  const sourceHint = sourceLang ? ` from ${sourceLang}` : ''
  return `You are a precise translation engine. Translate the following text${sourceHint} into ${targetLang}. Preserve formatting, tone, and meaning. Respond with ONLY the translated text, no explanations.`
}

async function callOpenRouter(
  pool: OpenRouterPool,
  client: ReturnType<OpenRouterPool['getAvailableClient']>,
  body: OpenRouterChatRequest,
): Promise<OpenRouterChatResponse> {
  if (!client) {
    throw createError({
      statusCode: 503,
      statusMessage: 'No available OpenRouter clients',
    })
  }

  const response = await fetch(`${client.apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${client.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after')
    const retryMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 60_000
    pool.handleRateLimitError(client, retryMs)
    throw createError({
      statusCode: 429,
      statusMessage: 'Rate limited by OpenRouter',
    })
  }

  if (response.status === 402) {
    pool.handle402Error(client)
    throw createError({
      statusCode: 402,
      statusMessage: 'Payment required / DDoS block',
    })
  }

  if (!response.ok) {
    const errorText = await response.text()
    throw createError({
      statusCode: 502,
      statusMessage: `OpenRouter error: ${response.status} ${errorText}`,
    })
  }

  return (await response.json()) as OpenRouterChatResponse
}

function getOrCreatePool(apiKeys?: string[]): OpenRouterPool {
  if (apiKeys?.length) {
    return new OpenRouterPool({ clients: apiKeys.map((k) => ({ apiKey: k })) })
  }

  const pool = poolSupplier.getPool()
  if (pool.availableSize() === 0) {
    throw createError({
      statusCode: 500,
      statusMessage: 'No OpenRouter API keys configured',
    })
  }
  return pool
}

export default defineEventHandler(async (event) => {
  const body = await readBody<TranslateRequest>(event)
  const query = getQuery(event)
  const runId = getHeader(event, 'x-mt-run-id') ?? null
  const stepId = getHeader(event, 'x-mt-step-id') ?? null

  if (isMockMode()) {
    const texts = Array.isArray(body.text) ? body.text : [body.text]
    const results = texts.map((t) => ({
      translatedText: `[MOCK] ${t}`,
      model: 'mock',
      tokens: 0,
    }))
    return query.batch
      ? { results }
      : (results[0] ?? { translatedText: '', model: 'mock', tokens: 0 })
  }

  const pool = getOrCreatePool(body.apiKeys)
  const model = body.model ?? 'openai/gpt-4o-mini'
  const texts = Array.isArray(body.text) ? body.text : [body.text]

  const results: TranslateResponse[] = []
  for (const text of texts) {
    const client = pool.getAvailableClient(model)

    const chatBody: OpenRouterChatRequest = {
      model,
      messages: [
        { role: 'system', content: buildSystemPrompt(body.targetLang, body.sourceLang) },
        { role: 'user', content: text },
      ],
    }

    try {
      const data = await callOpenRouter(pool, client, chatBody)
      const translatedText = data.choices?.[0]?.message?.content ?? ''
      const tokens = data.usage?.total_tokens ?? 0

      void logCall(runId, stepId, model, {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      })

      results.push({ translatedText, model, tokens })
    } catch (err) {
      // If rate-limited, retry once with next client
      if (err && typeof err === 'object' && 'statusCode' in err && err.statusCode === 429) {
        const nextClient = pool.getAvailableClient(model)
        if (nextClient) {
          const data = await callOpenRouter(pool, nextClient, chatBody)
          const translatedText = data.choices?.[0]?.message?.content ?? ''
          const tokens = data.usage?.total_tokens ?? 0

          void logCall(runId, stepId, model, {
            promptTokens: data.usage?.prompt_tokens ?? 0,
            completionTokens: data.usage?.completion_tokens ?? 0,
          })

          results.push({ translatedText, model, tokens })
          continue
        }
      }
      throw err
    }
  }

  if (query.batch || Array.isArray(body.text)) {
    return { results } as BatchTranslateResponse
  }

  return results[0] ?? { translatedText: '', model, tokens: 0 }
})
