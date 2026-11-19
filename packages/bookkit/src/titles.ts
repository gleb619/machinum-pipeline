import { annotate, category, defineTool, tool, withItem } from '@mt/core'
import {
  LineParityError,
  LlmError,
  TITLE_RULES,
  buildTranslationPrompt,
  lintLineParity,
  loadGlossaryOrEmpty,
  parseTranslationReply,
  resolveProcessLlm,
} from '@mt/tools'
import type { SchemaDocLlmCall } from '@mt/tools'

export interface BatchTitleTranslatorOptions {
  /**
   * Backend for the batch request. Precedence: this option > process-level installed
   * provider / picked backend (`resolveProcessLlm().schemaCall`) > error at invoke.
   */
  call?: SchemaDocLlmCall
  /** Directory with `glossary.json`. */
  chaptersDir: string
  /** Output budget of the single batch request. Default 2048. */
  maxTokens?: number
}

interface TitleInput {
  text: string
  targetLang: string
  sourceLang?: string
}

/**
 * Translates the whole title batch of a `batch://?size=5` subflow in ONE `xml` request instead
 * of one request per chapter (~21 title calls per book otherwise). The prompt keeps the title
 * rules and glossary of `createGlossaryTitleTranslator`; every title is parity-checked on its
 * own and a bad batch throws a retryable error, so the engine retries the batch.
 */
export function createBatchTitleTranslator(options: BatchTitleTranslatorOptions) {
  return annotate(
    defineTool<TitleInput, { text: string }>({
      name: 'batch-title-translator',
      version: '1.0.0',
      description:
        'Translates a batch of chapter titles with one xml request (title rules + glossary).',
      async invoke(env, ctx) {
        const call = options.call ?? resolveProcessLlm()?.schemaCall
        if (!call) {
          throw new LlmError(
            'batch-title-translator: no LLM backend available; pass options.call or install/configure a process-level LLM provider',
          )
        }
        const inputs = env.items ?? (Array.isArray(env.item) ? env.item : [env.item])
        // `chaptersToTitleInputs` emits the whole `# heading` line; the translator sees the title
        // without the markdown marker (same as `titleExtract` does for the per-title tool).
        const titles = inputs.map((input) => input.text.replace(/^#\s+/, '').trim())
        const glossary = await loadGlossaryOrEmpty(options.chaptersDir)
        const prompt = buildTranslationPrompt({
          text: titles.join('\n'),
          glossary,
          extraRules: TITLE_RULES,
          mode: 'xml',
        })
        const res = await call(
          {
            systemPrompt: prompt.systemPrompt,
            messages: [{ role: 'user', content: prompt.userPrompt }],
            temperature: 0.2,
            maxTokens: options.maxTokens ?? 2048,
          },
          ctx,
        )
        if (res.finishReason === 'length') {
          throw new LlmError('title batch truncated at maxTokens (finishReason: length)', {
            retryable: true,
          })
        }
        const lines = parseTranslationReply(res.content, 'xml').lines
        if (lines.length !== titles.length) {
          throw new LlmError(`title batch returned ${lines.length} line(s) for ${titles.length}`, {
            retryable: true,
          })
        }
        const ru = lines.map((line, i) => {
          const title = titles[i] ?? ''
          const verdict = lintLineParity(title, line, { cyrillicSeverity: 'error' })
          if (!verdict.ok) throw new LineParityError(verdict, `title ${i + 1}`)
          return line
        })
        const outs = ru.map((text) => ({ text: `# ${text}` }))
        return withItem(env, (env.items ? outs : outs[0]) as { text: string })
      },
    }),
    tool('TL279', {
      name: 'batch-title-translator',
      description: 'Translates a batch of chapter titles with one xml request.',
      refs: ['UC059'],
    }),
    category(['translator']),
  )
}
