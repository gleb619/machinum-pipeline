import { category, defineTool, tool } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { VOCABULARY_DEFAULT_LIMIT, VOCABULARY_MAX_LIMIT } from '../../constants.js'
import type { ChunkModeOptions } from '../../core/chunk-processor.js'
import { readNumber } from '../../core/values.js'
import { exField } from '../fields.js'
import { parseWordList, roundTripIssue } from './doc.js'
import type { ChapterSource } from './doc.js'
import { runExtractor } from './extractor.js'
import type { ExtractorSpec } from './extractor.js'
import type { PromptValidation, SchemaDocLlmOptions } from './llm.js'

export const VOCABULARY_SYSTEM_PROMPT =
  'You extract terminology from a chapter. Reply in CSV only: a header row `word`, then one ' +
  'lowercase word or short term per row. Use only terms that occur in the chapter text. ' +
  'No code fence, no definitions, no prose.'

export const VOCABULARY_USER_PROMPT =
  'List up to {{limit}} key terms from this chapter, most important first, in descending order.\n\n' +
  '# {{title}}\n\n{{body}}'

/** Back-compat local aliases of the shared vocabulary limits. */
const DEFAULT_LIMIT = VOCABULARY_DEFAULT_LIMIT
const MAX_LIMIT = VOCABULARY_MAX_LIMIT

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

/** Per-invoke state: the term limit and the already-known words. */
interface VocabularyState {
  limit: number
  knownWords: string[]
  known: Set<string>
}

/**
 * The vocabulary tool: the limit and the known words are per-invoke state, so the spec
 * is built per factory (the limit can be overridden by the factory options).
 */
function createSpec(optionLimit: number | undefined): ExtractorSpec<string[], VocabularyState> {
  return {
    key: 'vocabulary',
    defaults: () => ({
      systemPrompt: VOCABULARY_SYSTEM_PROMPT,
      userPrompt: VOCABULARY_USER_PROMPT,
    }),
    createState: (env) => {
      const knownWords = [...readKnownWords(env)]
      return {
        limit: Math.min(
          MAX_LIMIT,
          Math.max(
            1,
            Math.floor(readNumber(exField(env, 'vocabularyLimit')) ?? optionLimit ?? DEFAULT_LIMIT),
          ),
        ),
        knownWords,
        known: new Set(knownWords),
      }
    },
    vars: (run) => ({ limit: run.state.limit }),
    validate: (content, run) => validateVocabulary(content, run.source, run.state.limit),
    transform: (value, run) => value.slice(0, run.state.limit),
    // A failed chunk contributes nothing; an empty result falls back to the summary words.
    partFallback: () => [],
    fallback: (run) => deterministicWords(run.source),
    merge: (lists, run) => [...new Set(lists.flat())].slice(0, run.state.limit),
    postProcess: (value, run) => {
      const candidates = value.length > 0 ? value : deterministicWords(run.source)
      const newWords = [...new Set(candidates)].filter((word) => !run.state.known.has(word))
      for (const word of newWords) {
        run.state.known.add(word)
      }
      run.state.knownWords.push(...newWords)
      return newWords
    },
    extraVariables: (_values, _env, state) => ({ knownWords: state.knownWords }),
    empty: [],
  }
}

/**
 * Builds the vocabulary tool.
 *
 * Deduplication against variable `knownWords` is preserved: only unseen terms are
 * reported as variable `vocabulary`, and variable `knownWords` accumulates across items.
 * Per-envelope overrides: variable `schemaDocLlm`, variable `vocabularyLimit`,
 * variable `vocabularyPrompt` / variable `vocabularySystemPrompt`.
 */
export function createVocabularyTool(
  options?: SchemaDocLlmOptions & ChunkModeOptions & { limit?: number },
) {
  const {
    limit: optionLimit,
    chunkMode,
    outputReserve,
    reserve,
    splitUnit,
    chunkConcurrency,
    ...llmOptions
  } = options ?? {}
  const spec = createSpec(optionLimit)

  return defineTool<string, string>({
    name: 'vocabulary',
    version: '1.2.0',
    mdDescription:
      'Extracts key terms from the chapter with an LLM through the OpenRouter proxy, deduplicates ' +
      'them against variable `knownWords`, and falls back to summary word extraction when the loop guard ' +
      'is exhausted. Supports shrink/chunk/auto modes (terms merged and deduped across chunks). Stores ' +
      'variable `vocabulary` and variable `knownWords`.',
    annotations: [
      tool('TL030', {
        name: 'vocabulary',
        description: 'Extracts key terms and dedupes them against known words.',
        refs: [],
      }),
      category(['extractor', 'llm']),
    ],
    async invoke(env: Exchange<string>, ctx: ToolContext): Promise<Exchange<string>> {
      return runExtractor(spec, env, ctx, llmOptions, {
        chunkMode,
        outputReserve,
        reserve,
        splitUnit,
        chunkConcurrency,
      })
    },
  })
}

/** Vocabulary tool with the default prompts and model. */
export const vocabularyTool = createVocabularyTool()
