import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'

export interface TranslateInput {
  text: string
  sourceLang?: string
  targetLang: string
}

export interface TranslateOutput {
  translatedText: string
  model?: string
  tokens?: number
}

export interface TranslateToolConfig {
  targetLang: string
  batchSize?: number
  chunkSize?: number
}

async function translateSingle(
  text: string,
  targetLang: string,
  sourceLang: string | undefined,
  routerUrl: string,
): Promise<TranslateOutput> {
  const url = new URL('/api/translate', routerUrl)
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, targetLang, sourceLang }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Translation failed: ${response.status} ${error}`)
  }

  return (await response.json()) as TranslateOutput
}

export const translateText = defineTool<TranslateInput, TranslateOutput>({
  name: 'translate-text',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(
    env: Envelope<TranslateInput>,
    ctx: ToolContext,
  ): Promise<Envelope<TranslateOutput>> {
    const routerUrl = ctx.run.global.routerUrl ?? 'http://localhost:7777'
    const inputs = env.items ?? [env.item]

    const results: TranslateOutput[] = []
    for (const input of inputs) {
      const result = await translateSingle(
        input.text,
        input.targetLang,
        input.sourceLang,
        routerUrl,
      )
      results.push(result)
    }

    const output = env.items ? results : results[0]
    return {
      item: output as TranslateOutput,
      meta: {
        ...env.meta,
        translated: true,
        count: results.length,
      },
    }
  },
})
