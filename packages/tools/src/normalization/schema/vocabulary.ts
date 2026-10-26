import { defineTool } from '@mt/core'
import { setVariables } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { exField } from '../fields.js'
import { chapterVars, parseWordList, readChapter, renderPrompt, roundTripIssue } from './doc.js'
import type { ChapterSource } from './doc.js'
import { attemptMeta, resolveLlmOptions, runPromptWithRetry } from './llm.js'
import type { PromptRetryResult, PromptValidation, SchemaDocLlmOptions } from './llm.js'

export const VOCABULARY_SYSTEM_PROMPT =
  'You extract terminology from a chapter. Reply in CSV only: a header row `word`, then one ' +
  'lowercase word or short term per row. Use only terms that occur in the chapter text. ' +
  'No code fence, no definitions, no prose.'

export const VOCABULARY_USER_PROMPT =
  'List up to {{limit}} key terms from this chapter, most important first, in descending order.\n\n' +
  '# {{title}}\n\n{{body}}'

const DEFAULT_LIMIT = 40
const MAX_LIMIT = 300

function validateVocabulary(
  content: string,
  source: ChapterSource,
  limit: number,
): PromptValidation<string[]> {
  const words = parseWordList(content)
  if (words.length === 0) {
    return {
      ok: false,
      reason: 'no terms found - reply with CSV rows shaped `word` followed by one term per row',
    }
  }
  if (words.length > MAX_LIMIT) {
    return {
      ok: false,
      reason: `${words.length} terms is more than the ${MAX_LIMIT} accepted - keep the most important ${limit}`,
    }
  }

  const body = source.body.toLowerCase()
  const invented = words.filter((word) => !body.includes(word))
  if (invented.length > words.length / 2) {
    return {
      ok: false,
      reason: `you invented terms that do not occur in the chapter: ${invented
        .slice(0, 8)
        .join(', ')} - list only words present in the text`,
    }
  }

  const grounded = words.filter((word) => body.includes(word))
  const parseIssue = roundTripIssue(
    { ...source.doc, vocabulary: grounded },
    (doc) => doc.vocabulary,
    'vocabulary',
  )
  if (parseIssue) {
    return { ok: false, reason: parseIssue }
  }

  return { ok: true, value: grounded }
}

/** Narrow variable `knownWords` to strings, matching the pre-LLM behaviour. */
function readKnownWords(ex: Pick<Exchange<unknown>, 'meta' | 'variables'>): string[] {
  const raw = exField<unknown>(ex, 'knownWords')
  return Array.isArray(raw) && raw.every((word): word is string => typeof word === 'string')
    ? raw
    : []
}

/** Deterministic vocabulary: words from the summary, as before the LLM refactor. */
function deterministicWords(source: ChapterSource): string[] {
  const words = source.doc.summary.match(/\b[a-z]{2,}\b/gi) ?? []
  return [...new Set(words.map((word) => word.toLowerCase()))]
}

const DEFAULTS: SchemaDocLlmOptions = {
  systemPrompt: VOCABULARY_SYSTEM_PROMPT,
  userPrompt: VOCABULARY_USER_PROMPT,
}

/**
 * Builds the vocabulary tool.
 *
 * Deduplication against variable `knownWords` is preserved: only unseen terms are
 * reported as variable `vocabulary`, and variable `knownWords` accumulates across items.
 * Per-envelope overrides: variable `schemaDocLlm`, variable `vocabularyLimit`,
 * variable `vocabularyPrompt` / variable `vocabularySystemPrompt`.
 */
export function createVocabularyTool(options?: SchemaDocLlmOptions & { limit?: number }) {
  return defineTool<string, string>({
    name: 'vocabulary',
    version: '1.1.0',
    mdDescription:
      'Extracts key terms from the chapter with an LLM through the OpenRouter proxy, deduplicates ' +
      'them against variable `knownWords`, and falls back to summary word extraction when the loop guard ' +
      'is exhausted. Stores variable `vocabulary` and variable `knownWords`.',
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      const { limit: optionLimit, ...llmOptions } = options ?? {}
      const resolved = resolveLlmOptions({ ...DEFAULTS, ...llmOptions }, env, 'vocabulary')
      const limit = Math.min(
        MAX_LIMIT,
        Math.max(
          1,
          Math.floor(readNumber(exField(env, 'vocabularyLimit')) ?? optionLimit ?? DEFAULT_LIMIT),
        ),
      )
      const inputs = env.items ?? [env.item]

      const knownWords = [...readKnownWords(env)]
      const knownSet = new Set(knownWords)
      const perItem: string[][] = []
      const results: PromptRetryResult<string[]>[] = []

      for (const input of inputs) {
        const source = readChapter(input)
        const outcome = await runPromptWithRetry(ctx, {
          ...resolved,
          systemPrompt: renderPrompt(resolved.systemPrompt ?? VOCABULARY_SYSTEM_PROMPT, {
            ...chapterVars(source),
            limit,
          }),
          userPrompt: renderPrompt(resolved.userPrompt ?? VOCABULARY_USER_PROMPT, {
            ...chapterVars(source),
            limit,
          }),
          validate: (content) => validateVocabulary(content, source, limit),
        })

        const candidates =
          outcome.ok && outcome.value ? outcome.value.slice(0, limit) : deterministicWords(source)

        const newWords = [...new Set(candidates)].filter((word) => !knownSet.has(word))
        for (const word of newWords) {
          knownSet.add(word)
        }
        knownWords.push(...newWords)
        perItem.push(newWords)
        results.push(outcome)
      }

      const values: Record<string, unknown> = {
        vocabulary: perItem[0] ?? [],
        knownWords,
        vocabularyLlm: attemptMeta(results),
      }
      if (env.items) {
        values.vocabularyByItem = perItem
      }
      return setVariables(env, values)
    },
  })
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Vocabulary tool with the default prompts and model. */
export const vocabularyTool = createVocabularyTool()
