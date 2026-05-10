import { createError, defineEventHandler, getHeader, readBody, getQuery } from 'h3'
import { OpenRouterPool } from '@mt/tools'
import { isMockMode } from '../../plugins/mock-mode.js'
import { logCall } from '../../utils/cost-tracker.js'

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
    const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000
    const pool = globalThis.__openRouterPool as OpenRouterPool | undefined
    if (pool) {
      pool.handleRateLimitError(client, retryMs)
    }
    throw createError({
      statusCode: 429,
      statusMessage: 'Rate limited by OpenRouter',
    })
  }

  if (response.status === 402) {
    const pool = globalThis.__openRouterPool as OpenRouterPool | undefined
    if (pool) {
      pool.handle402Error(client)
    }
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
  const keys = apiKeys?.length
    ? apiKeys.map((k) => ({ apiKey: k }))
    : (process.env.OPENROUTER_API_KEYS ?? process.env.OPENROUTER_API_KEY ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
        .map((k) => ({ apiKey: k }))

  if (!keys.length) {
    throw createError({
      statusCode: 500,
      statusMessage: 'No OpenRouter API keys configured',
    })
  }

  const existing = globalThis.__openRouterPool as OpenRouterPool | undefined
  if (existing && !existing.isExpired()) {
    return existing
  }

  const pool = new OpenRouterPool({ clients: keys })
  globalThis.__openRouterPool = pool
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
      : results[0] ?? { translatedText: '', model: 'mock', tokens: 0 }
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
      const data = await callOpenRouter(client, chatBody)
      const translatedText = data.choices?.[0]?.message?.content ?? ''
      const tokens = data.usage?.total_tokens ?? 0

      void logCall(runId, stepId, model, {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      })

      results.push({ translatedText, model, tokens })
    } catch (err) {
      // If rate-limited, retry once with next client
      if (
        err &&
        typeof err === 'object' &&
        'statusCode' in err &&
        err.statusCode === 429
      ) {
        const nextClient = pool.getAvailableClient(model)
        if (nextClient) {
          const data = await callOpenRouter(nextClient, chatBody)
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
