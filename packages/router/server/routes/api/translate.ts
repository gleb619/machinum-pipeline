import { createError, defineEventHandler, getHeader, getQuery, readBody } from 'h3'
import { isMockMode } from '../../plugins/mock-mode.js'
import { logCall } from '../../utils/cost-tracker.js'
import { OpenRouterPool } from '../../utils/openrouter-pool.js'
import { redactError } from '../../utils/redact.js'
import { callUpstream } from '../../utils/upstream-call.js'
import { DEFAULT_UPSTREAM, getUpstreamRegistry } from '../../utils/upstream.js'

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

interface ChatResponse {
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

  const registry = getUpstreamRegistry()
  const requested = body.model ?? registry.defaultUpstream.defaultModel ?? 'openai/gpt-4o-mini'
  const { upstream, upstreamModel } = registry.resolve(requested)
  // Per-request apiKeys only override the default (openrouter) upstream; keyless / vault
  // upstreams always use their registry credentials.
  const pool =
    body.apiKeys?.length && upstream.name === DEFAULT_UPSTREAM
      ? new OpenRouterPool({ clients: body.apiKeys.map((k) => ({ apiKey: k })) })
      : upstream.getPool()
  const texts = Array.isArray(body.text) ? body.text : [body.text]

  const results: TranslateResponse[] = []
  try {
    for (const text of texts) {
      const payload = JSON.stringify({
        model: upstreamModel,
        messages: [
          { role: 'system', content: buildSystemPrompt(body.targetLang, body.sourceLang) },
          { role: 'user', content: text },
        ],
      })
      const response = await callUpstream(event, upstream, upstreamModel, payload, pool)
      const data = (await response.json()) as ChatResponse
      const translatedText = data.choices?.[0]?.message?.content ?? ''
      const tokens = data.usage?.total_tokens ?? 0

      void logCall(
        runId,
        stepId,
        requested,
        {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
        },
        { upstream: upstream.name, free: upstream.kind !== 'openrouter' },
      )

      results.push({ translatedText, model: requested, tokens })
    }
  } catch (err) {
    if (err instanceof Error && 'statusCode' in err) throw err
    throw createError({ statusCode: 502, statusMessage: `Proxy error: ${redactError(err)}` })
  }

  if (query.batch || Array.isArray(body.text)) {
    return { results } as BatchTranslateResponse
  }

  return results[0] ?? { translatedText: '', model: requested, tokens: 0 }
})
