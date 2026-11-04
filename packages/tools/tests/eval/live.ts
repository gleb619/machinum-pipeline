import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExchange, variable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { OLLAMA_BASE_URL, OLLAMA_MODEL, ollamaHealth } from '../../src/core/ollama-tool.js'
import type { ChatCompletionInput, ChatCompletionOutput } from '../../src/core/openrouter-tool.js'
import type { SchemaDocLlmCall } from '../../src/normalization/schema/llm.js'
import { tagTerms } from '../../src/normalization/term-tagger.js'
import type { Glossary } from '../../src/normalization/term-tagger.js'
import {
  createChapterBodyTranslator,
  createGlossaryTitleTranslator,
} from '../../src/normalization/translation-stage.js'
import { formatMetricTable, scoreChapter } from './score.js'
import type { MetricRow } from './score.js'

export interface LiveEvalReport {
  baseUrl: string
  model: string
  rows: MetricRow[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function parseChatResponse(data: unknown, fallbackModel: string): ChatCompletionOutput {
  const root = asRecord(data)
  const choices = Array.isArray(root?.choices) ? root.choices : []
  const message = asRecord(asRecord(choices[0])?.message)
  const content = typeof message?.content === 'string' ? message.content : ''
  if (content.trim() === '') throw new Error('ollama chat returned empty content')

  const usage = asRecord(root?.usage)
  const promptTokens = numberOf(usage?.prompt_tokens)
  const completionTokens = numberOf(usage?.completion_tokens)
  const tokens = numberOf(usage?.total_tokens) || promptTokens + completionTokens
  const model = typeof root?.model === 'string' ? root.model : fallbackModel
  return { content, model, tokens, promptTokens, completionTokens }
}

function ollamaCall(baseUrl: string, model: string): SchemaDocLlmCall {
  return async (input: ChatCompletionInput): Promise<ChatCompletionOutput> => {
    const messages = [
      ...(input.systemPrompt ? [{ role: 'system' as const, content: input.systemPrompt }] : []),
      ...input.messages,
    ]
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature: input.temperature,
        max_tokens: input.maxTokens,
      }),
      signal: AbortSignal.timeout(180_000),
    })
    if (!res.ok) {
      throw new Error(`ollama chat failed: HTTP ${res.status} (${baseUrl})`)
    }
    return parseChatResponse(await res.json(), model)
  }
}

/**
 * Opt-in live run: same fixtures through `createChapterBodyTranslator` against the ollama
 * server. Returns metrics for reporting only; the caller does not gate on them.
 */
export async function runLiveEval(): Promise<LiveEvalReport> {
  const baseUrl = process.env.MT_OLLAMA_URL ?? OLLAMA_BASE_URL
  const model = process.env.MT_OLLAMA_MODEL ?? OLLAMA_MODEL
  const health = await ollamaHealth(baseUrl)
  if (!health.ok) {
    throw new Error(
      `live eval: ollama server unreachable at ${health.baseUrl} (${health.error ?? 'health check failed'}). Set MT_OLLAMA_URL to the GPU server or omit --live.`,
    )
  }

  const evalDir = new URL('.', import.meta.url)
  const fixturesDir = new URL('fixtures/', evalDir)
  const glossary = JSON.parse(
    await readFile(new URL('glossary.json', fixturesDir), 'utf-8'),
  ) as Glossary

  const dir = await mkdtemp(join(tmpdir(), 'mt-eval-live-'))
  try {
    await writeFile(join(dir, 'glossary.json'), JSON.stringify(glossary))
    const call = ollamaCall(baseUrl, model)
    const titleTool = createGlossaryTitleTranslator({ call, chaptersDir: dir })
    const bodyTool = createChapterBodyTranslator({ call, chaptersDir: dir, log: false })
    const ctx = {} as ToolContext
    const rows: MetricRow[] = []

    for (const chapter of [1, 2, 3]) {
      const label = `chapter${chapter}`
      const en = (await readFile(new URL(`${label}.md`, fixturesDir), 'utf-8')).trim()
      const heading = /^#\s+(.+)$/m.exec(en)?.[1] ?? label
      const title = await titleTool.invoke(
        createExchange({ text: heading, targetLang: 'ru', sourceLang: 'en' }),
        ctx,
      )
      const titleRu = title.item.translatedText
      const body = await bodyTool.invoke(
        createExchange(
          { text: titleRu },
          {
            variables: [variable('chapters', [tagTerms(en, glossary)])],
            items: [{ text: titleRu }],
          },
        ),
        ctx,
      )
      const pair = body.items?.[0]
      if (!pair) throw new Error(`live eval: no body pair for ${label}`)
      rows.push({ label, metrics: scoreChapter(en, pair.ru, glossary).metrics })
    }

    return { baseUrl: health.baseUrl, model, rows }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export function formatLiveReport(report: LiveEvalReport): string {
  return [
    `live eval (report only, not a gate) — ${report.baseUrl} model ${report.model}`,
    formatMetricTable(report.rows),
  ].join('\n')
}
