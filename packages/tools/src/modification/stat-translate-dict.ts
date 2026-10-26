import { defineTool } from '@mt/core'
import type { ComposableTool, Envelope, Tool } from '@mt/core'
import { z } from 'zod'
import { atomicWriteFile, ensureParentDir } from '../core/fs-write.js'
import type { LlmConfigLayer } from '../core/llm-config.js'
import {
  type GateInput,
  type GateSlot,
  type GateState,
  type LlmGateOptions,
  createLlmGate,
  extractJson,
  llmEmit,
} from '../core/llm-gate.js'
import type { Glossary, GlossaryTerm } from '../normalization/term-tagger.js'

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface StatTranslateDictOptions {
  /** Tool-level LLM config (provider/model/keys/...). */
  llm?: LlmConfigLayer
  /** Max number of untranslated entries sent per LLM call. Default: 20. */
  batchSize?: number
  /** Target language code. Default: 'ru'. */
  targetLang?: string
  /** When set, the translated glossary is also written as JSON (atomic write). */
  outFile?: string
}

interface BatchEntry {
  id: string
  term: string
  type: GlossaryTerm['type']
  aliases: string[]
}

interface TranslationResult {
  id: string
  ru: string
}

const outputSchema = z.object({
  translations: z.array(
    z.object({
      id: z.string().min(1),
      ru: z.string().min(1),
    }),
  ),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SOURCE_LANG = 'English'
const DEFAULT_TARGET_LANG = 'ru'
const DEFAULT_BATCH_SIZE = 20

function isUntranslated(term: GlossaryTerm): boolean {
  return term.ru === null || term.ru.trim() === ''
}

function selectBatch(glossary: Glossary, batchSize: number): GlossaryTerm[] {
  return (glossary.terms ?? []).filter(isUntranslated).slice(0, batchSize)
}

function toBatchEntry(term: GlossaryTerm): BatchEntry {
  return {
    id: term.id,
    term: term.term,
    type: term.type,
    aliases: term.aliases ?? [],
  }
}

function genderInstruction(targetLang: string): string {
  if (targetLang.toLowerCase() !== 'ru') return ''
  return (
    '- For Russian translations, include an explicit grammatical gender marker (m./f./n.) ' +
    'and a short declension hint when relevant, so downstream inflection can choose the correct form.'
  )
}

function mergeTranslations(glossary: Glossary, translations: TranslationResult[]): Glossary {
  const byId = new Map(translations.map((t) => [t.id, t.ru]))
  return {
    ...glossary,
    terms: glossary.terms.map((term) => {
      const ru = byId.get(term.id)
      if (ru !== undefined && isUntranslated(term)) {
        return { ...term, ru }
      }
      return term
    }),
  }
}

/** Validate that every batched id is returned with a non-empty translation. */
function validateDictResponse(glossary: Glossary, batchSize: number, json: unknown) {
  const parsed = outputSchema.parse(json)
  const batch = selectBatch(glossary, batchSize)
  const expected = new Set(batch.map((t) => t.id))
  const returned = new Set(parsed.translations.map((t) => t.id))
  if (expected.size !== returned.size || ![...expected].every((id) => returned.has(id))) {
    throw new Error(
      `Returned ids do not match batched ids. Expected: ${[...expected].sort().join(', ')}; got: ${[...returned].sort().join(', ')}`,
    )
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Gate parts
// ---------------------------------------------------------------------------

function buildNormalize(options: StatTranslateDictOptions) {
  return (input: Glossary): GateInput => {
    const targetLang = options.targetLang ?? DEFAULT_TARGET_LANG
    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE)
    const batch = selectBatch(input, batchSize)
    return {
      systemPromptName: 'stat-translate-dict.system',
      promptName: 'stat-translate-dict.user',
      vars: {
        sourceLang: SOURCE_LANG,
        targetLang,
        genderInstruction: genderInstruction(targetLang),
        entries: JSON.stringify(batch.map(toBatchEntry), null, 2),
      },
      responseFormat: 'json',
    }
  }
}

function buildCheck(options: StatTranslateDictOptions) {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE)
  return (content: string, input: Glossary) => {
    const json = extractJson(content)
    validateDictResponse(input, batchSize, json)
  }
}

function buildToOutput() {
  return (state: GateState<Glossary>): Glossary => {
    if (state.json === undefined) {
      throw new Error('stat-translate-dict emit slot: state.json missing (did parse run?)')
    }
    const { translations } = state.json as { translations: TranslationResult[] }
    return mergeTranslations(state.input, translations)
  }
}

function buildEmit(
  options: StatTranslateDictOptions,
  gateOptions: LlmGateOptions<Glossary, Glossary>,
): Tool<GateState<Glossary>, Glossary> {
  const baseEmit = llmEmit(gateOptions)
  return defineTool<GateState<Glossary>, Glossary>({
    name: 'stat-translate-dict:emit',
    version: '1.0.0',
    mdDescription: options.outFile
      ? `Merges translations back into the glossary and writes ${options.outFile}.`
      : 'Merges translations back into the glossary.',
    async invoke(env, _ctx) {
      const out = await baseEmit.invoke(env, _ctx)
      if (options.outFile) {
        if (env.items) {
          throw new Error(
            'stat-translate-dict: outFile is not supported when the input is a batched array of glossaries',
          )
        }
        const glossary = out.item
        await ensureParentDir(options.outFile)
        await atomicWriteFile(options.outFile, JSON.stringify(glossary, null, 2))
      }
      return out
    },
  })
}

// ---------------------------------------------------------------------------
// Factory + default instance
// ---------------------------------------------------------------------------

/**
 * LLM translation gate for ranked dictionary entries (T149).
 *
 * Sends untranslated entries from a {@link Glossary} to the LLM in batches, validates that the
 * returned ids match exactly, and merges the non-empty translations back into the original
 * glossary. Usage is recorded in the `llmUsage` variable; the result is also available in
 * the `statDict` variable when the caller places it there.
 *
 * Composable slots: `prepare -> fit -> call -> parse -> emit`. Swap any part, e.g.
 * `gate.with({ call: mockLlmCall([...]) })` for tests.
 */
export function createStatTranslateDict(
  options: StatTranslateDictOptions = {},
): ComposableTool<Glossary, Glossary, GateSlot> {
  const gateOptions: LlmGateOptions<Glossary, Glossary> = {
    name: 'stat-translate-dict',
    version: '1.0.0',
    mdDescription:
      'Translates untranslated dictionary entries in batches via an LLM, validates id parity, ' +
      'and merges translations back into the glossary.',
    llm: options.llm,
    normalize: buildNormalize(options),
    check: buildCheck(options),
    toOutput: buildToOutput(),
    metaFlags: { statTranslateDict: true },
  }
  const gate = createLlmGate<Glossary, Glossary>(gateOptions)
  return gate.with({ emit: buildEmit(options, gateOptions) })
}

/** Default dictionary translator: English -> Russian, 20 entries per call. */
export const statTranslateDict = createStatTranslateDict()
