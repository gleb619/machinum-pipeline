import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'
import {
  chapterVars,
  countWords,
  frequentTerms,
  readChapter,
  renderPrompt,
  roundTripIssue,
} from './doc.js'
import type { ChapterSource } from './doc.js'
import { attemptMeta, resolveLlmOptions, runPromptWithRetry } from './llm.js'
import type { PromptRetryResult, PromptValidation, SchemaDocLlmOptions } from './llm.js'

export const SUMMARY_SYSTEM_PROMPT =
  'You are a technical editor. Summarise the chapter you are given as one flowing paragraph of ' +
  '3 to 6 sentences. Reply with the summary text only: no headings, no bullet lists, no markdown ' +
  'sections, no preamble.'

export const SUMMARY_USER_PROMPT = 'Summarise this chapter.\n\n# {{title}}\n\n{{body}}'

/** Share of the chapter's key terms a summary must mention to count as covering the chapter. */
const MIN_TERM_COVERAGE = 0.15
const MIN_TERMS_FOR_COVERAGE = 5

function validateSummary(content: string, source: ChapterSource): PromptValidation<string> {
  const parseIssue = roundTripIssue(
    { ...source.doc, summary: content },
    (doc) => doc.summary,
    'summary',
  )
  if (parseIssue) {
    return { ok: false, reason: parseIssue }
  }

  const terms = frequentTerms(source.body)
  if (terms.length >= MIN_TERMS_FOR_COVERAGE) {
    const lowered = content.toLowerCase()
    const missing = terms.filter((term) => !lowered.includes(term))
    const required = Math.ceil(terms.length * MIN_TERM_COVERAGE)
    if (missing.length > terms.length - required) {
      return {
        ok: false,
        reason:
          `the summary omits ${missing.length} of ${terms.length} key chapter terms - you forgot: ` +
          `${missing.slice(0, 8).join(', ')}`,
      }
    }
  }

  const bodyWords = countWords(source.body)
  if (bodyWords >= 40 && countWords(content) > bodyWords) {
    return { ok: false, reason: 'the summary is longer than the chapter it summarises' }
  }

  return { ok: true, value: content }
}

const DEFAULTS: SchemaDocLlmOptions = {
  systemPrompt: SUMMARY_SYSTEM_PROMPT,
  userPrompt: SUMMARY_USER_PROMPT,
}

/**
 * Builds the LLM-backed summary tool.
 *
 * Options (`model`, `temperature`, `maxTokens`, `systemPrompt`, `userPrompt`,
 * `maxAttempts`, `routerUrl`) can also be overridden per envelope through
 * `meta.schemaDocLlm` or `meta.summaryPrompt` / `meta.summarySystemPrompt`.
 * When the loop guard is exhausted the schema-doc `## Summary` text is used, so a
 * missing or failing router never fails the run.
 */
export function createSummaryTool(options?: SchemaDocLlmOptions) {
  return defineTool<string, string>({
    name: 'summary',
    version: '1.1.0',
    mdDescription:
      'Summarises the chapter with an LLM through the OpenRouter proxy (configurable prompts, ' +
      'loop-guarded retries, deterministic schema-doc parse as fallback). Stores `meta.summary`.',
    async invoke(env: Envelope<string>, ctx: ToolContext): Promise<Envelope<string>> {
      const resolved = resolveLlmOptions({ ...DEFAULTS, ...options }, env.meta, 'summary')
      const inputs = env.items ?? [env.item]

      const summaries: string[] = []
      const results: PromptRetryResult<string>[] = []

      for (const input of inputs) {
        const source = readChapter(input)
        const outcome = await runPromptWithRetry(ctx, {
          ...resolved,
          systemPrompt: renderPrompt(
            resolved.systemPrompt ?? SUMMARY_SYSTEM_PROMPT,
            chapterVars(source),
          ),
          userPrompt: renderPrompt(resolved.userPrompt ?? SUMMARY_USER_PROMPT, chapterVars(source)),
          validate: (content) => validateSummary(content, source),
        })
        summaries.push(outcome.ok && outcome.value !== undefined ? outcome.value : source.body)
        results.push(outcome)
      }

      const meta: Envelope<string>['meta'] = {
        ...env.meta,
        summary: summaries[0] ?? '',
        summaryLlm: attemptMeta(results),
      }
      if (env.items) {
        meta.summaryByItem = summaries
      }
      return { ...env, meta }
    },
  })
}

/** Summary tool with the default prompts and model. */
export const summaryTool = createSummaryTool()
