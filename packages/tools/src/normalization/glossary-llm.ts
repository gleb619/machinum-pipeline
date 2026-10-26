import type { ToolContext } from '@mt/core'
import { loadBundledPrompt } from '../core/bundled-prompts.js'
import { extractJson } from '../core/llm-gate.js'
import { renderTemplate } from '../core/llm-prompts.js'
import {
  type LlmAttemptMeta,
  type SchemaDocLlmCall,
  attemptMeta,
  runPromptWithRetry,
} from './schema/llm.js'
import type { GlossaryChapter, GlossaryTermType } from './term-tagger.js'

/**
 * LLM stages of the glossary extractor (machinum-llm `GlossaryExtractor`,
 * `NameRelationAnalyzer` and `GlossaryEnrich`).
 *
 * The prompt texts are bundled md files (`packages/tools/prompts/glossary*.md`), ported
 * from the machinum-llm `.ST` templates; they are loaded through `loadBundledPrompt`, so
 * they ship inside the package and the single-file binary (no runtime file read).
 */

/** Bundled prompt names used by the glossary extractor. */
export const GLOSSARY_PROMPTS = {
  system: 'glossary.system',
  first: 'glossary-first.system',
  user: 'glossary.user',
  consolidated: 'glossary-consolidated.user',
  relationsSystem: 'glossary-relations.system',
  relationsUser: 'glossary-relations.user',
  enrichSystem: 'glossary-enrich.system',
  enrichUser: 'glossary-enrich.user',
} as const

/** One glossary entry reported by the model. */
export interface LlmGlossaryEntry {
  /** Term name as the model wrote it. */
  name: string
  /** Category of the term (`Character`, `Location`, ...). */
  category: string
  /** What the term means in the story. */
  description: string
  /** Names of the related terms. */
  references: string[]
}

/** One name-relation group reported by the model. */
export interface LlmNameRelation {
  /** Canonical (corrected) name of the group. */
  consolidatedName: string
  /** Names merged into the canonical one. */
  originalNames: string[]
  /** Terms semantically related to the canonical name. */
  relatedNames: string[]
  /** Confidence of the consolidation (0..1). */
  confidence: number
}

const CATEGORY_TYPES: Array<[RegExp, GlossaryTermType]> = [
  [/^(character|person|people|protagonist|antagonist|npc)$/i, 'character'],
  [/^(location|place|city|country|region|town|village|island|kingdom|realm)$/i, 'place'],
  [/^(object|item|artifact|weapon|treasure|equipment)$/i, 'item'],
  [/^(ability|skill|art|technique|spell|power)$/i, 'skill'],
]

/** Maps a model category to a glossary type (`Character` -> `character`). */
export function mapCategory(category: string): GlossaryTermType {
  const value = category.trim()
  for (const [pattern, type] of CATEGORY_TYPES) {
    if (pattern.test(value)) return type
  }
  return 'term'
}

/** Parses the glossary entries of a model reply; invalid entries are dropped. */
export function parseGlossaryEntries(content: string): LlmGlossaryEntry[] {
  let raw: unknown
  try {
    raw = extractJson(content)
  } catch {
    return []
  }
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : []
  const out: LlmGlossaryEntry[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (name === '') continue
    const references = Array.isArray(record.references)
      ? record.references
          .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
          .map((r) => r.trim())
      : []
    out.push({
      name,
      category: typeof record.category === 'string' ? record.category.trim() : '',
      description: typeof record.description === 'string' ? record.description.trim() : '',
      references,
    })
  }
  return out
}

/** Parses the name-relation groups of a model reply; invalid groups are dropped. */
export function parseNameRelations(content: string): LlmNameRelation[] {
  let raw: unknown
  try {
    raw = extractJson(content)
  } catch {
    return []
  }
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : []
  const out: LlmNameRelation[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const consolidated =
      typeof record.consolidatedName === 'string' ? record.consolidatedName.trim() : ''
    if (consolidated === '') continue
    const strings = (value: unknown): string[] =>
      Array.isArray(value)
        ? value
            .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
            .map((v) => v.trim())
        : []
    const confidence = typeof record.confidence === 'number' ? record.confidence : 0
    out.push({
      consolidatedName: consolidated,
      originalNames: strings(record.originalNames),
      relatedNames: strings(record.relatedNames),
      confidence: Math.min(1, Math.max(0, confidence)),
    })
  }
  return out
}

/** LLM knobs shared by every glossary stage. */
export interface GlossaryLlmOptions {
  /** LLM backend (e.g. `pickLlmTool().schemaCall`). */
  call: SchemaDocLlmCall
  model?: string
  temperature?: number
  maxTokens?: number
  /** Loop-guard budget: calls per stage before the deterministic fallback. */
  maxAttempts?: number
  /** System prompt override (defaults to the bundled prompt of the stage). */
  systemPrompt?: string
  /** User prompt override (defaults to the bundled prompt of the stage). */
  userPrompt?: string
}

/** Renders the corpus text for a prompt (truncated to `maxChars`). */
export function corpusText(chapters: GlossaryChapter[], maxChars = 12_000): string {
  const text = chapters.map((c) => c.text).join('\n\n')
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[...truncated]`
}

/** Renders a name list for a prompt (`none` when empty). */
function nameList(names: string[]): string {
  return names.length > 0 ? names.join(', ') : 'none'
}

export interface GlossaryExtractLlmArgs extends GlossaryLlmOptions {
  /** Chapters of the analysed corpus. */
  chapters: GlossaryChapter[]
  /** Names of the terms already in the glossary (reused, not re-extracted). */
  known?: string[]
  /** Candidate names to extract (heuristic + NER seeded). */
  candidates?: string[]
  /** Max characters of the corpus sent to the model. Default: 12000. */
  maxChars?: number
}

export interface GlossaryExtractLlmResult {
  entries: LlmGlossaryEntry[]
  meta: LlmAttemptMeta
}

/**
 * Stage A - extracts the glossary entries of the corpus with the bundled prompts.
 * Never throws: a rejected or unparsable reply yields no entries (the caller falls back
 * to the heuristic glossary).
 */
export async function extractGlossaryWithLlm(
  ctx: ToolContext,
  args: GlossaryExtractLlmArgs,
): Promise<GlossaryExtractLlmResult> {
  const systemPrompt = args.systemPrompt ?? loadBundledPrompt(GLOSSARY_PROMPTS.system)
  const userPrompt =
    args.userPrompt ??
    renderTemplate(loadBundledPrompt(GLOSSARY_PROMPTS.user), {
      text: corpusText(args.chapters, args.maxChars),
      known: nameList(args.known ?? []),
      candidates: nameList(args.candidates ?? []),
    })
  const result = await runPromptWithRetry(ctx, {
    call: args.call,
    model: args.model,
    temperature: args.temperature,
    maxTokens: args.maxTokens,
    maxAttempts: args.maxAttempts,
    systemPrompt,
    userPrompt,
    validate: (content) => {
      const entries = parseGlossaryEntries(content)
      if (entries.length === 0) {
        return { ok: false, reason: 'no glossary entries found - reply with a JSON array of terms' }
      }
      return { ok: true, value: entries }
    },
  })
  return {
    entries: result.ok ? (result.value ?? []) : [],
    meta: attemptMeta([result]),
  }
}

export interface GlossaryRelationsLlmArgs extends GlossaryLlmOptions {
  /** Term the relations are analysed for. */
  term: string
  /** Description of the term (context). */
  description?: string
  /** Names that look similar to the term. */
  similarNames?: string[]
  /** Names that are similar in context. */
  contextualSimilarNames?: string[]
  /** Extra context (chapter, neighbouring terms). */
  additionalDescriptions?: string
}

export interface GlossaryRelationsLlmResult {
  relations: LlmNameRelation[]
  meta: LlmAttemptMeta
}

/**
 * Stage B - analyses the relations of one term with the bundled NameRelations prompts.
 * Never throws: a rejected reply yields no relations.
 */
export async function relateTermWithLlm(
  ctx: ToolContext,
  args: GlossaryRelationsLlmArgs,
): Promise<GlossaryRelationsLlmResult> {
  const systemPrompt = args.systemPrompt ?? loadBundledPrompt(GLOSSARY_PROMPTS.relationsSystem)
  const userPrompt =
    args.userPrompt ??
    renderTemplate(loadBundledPrompt(GLOSSARY_PROMPTS.relationsUser), {
      term: args.term,
      description: args.description ?? '',
      similarNames: nameList(args.similarNames ?? []),
      contextualSimilarNames: nameList(args.contextualSimilarNames ?? []),
      additionalDescriptions: args.additionalDescriptions ?? 'none',
    })
  const result = await runPromptWithRetry(ctx, {
    call: args.call,
    model: args.model,
    temperature: args.temperature,
    maxTokens: args.maxTokens,
    maxAttempts: args.maxAttempts,
    systemPrompt,
    userPrompt,
    validate: (content) => {
      const relations = parseNameRelations(content)
      if (relations.length === 0) {
        return { ok: false, reason: 'no name relations found - reply with a JSON array' }
      }
      return { ok: true, value: relations }
    },
  })
  return {
    relations: result.ok ? (result.value ?? []) : [],
    meta: attemptMeta([result]),
  }
}

export interface GlossaryEnrichLlmArgs extends GlossaryLlmOptions {
  /** Term to describe. */
  term: string
  /** Chapter texts the term appears in. */
  chapters: GlossaryChapter[]
  /** Max characters of the text sent to the model. Default: 12000. */
  maxChars?: number
}

export interface GlossaryEnrichLlmResult {
  /** Bullet list of facts about the term (empty when the call failed). */
  description: string
  meta: LlmAttemptMeta
}

/**
 * Stage C - enriches one term with the bundled GlossaryEnrich prompts (a bullet list of
 * facts). Never throws: a rejected reply yields an empty description.
 */
export async function enrichTermWithLlm(
  ctx: ToolContext,
  args: GlossaryEnrichLlmArgs,
): Promise<GlossaryEnrichLlmResult> {
  const systemPrompt = args.systemPrompt ?? loadBundledPrompt(GLOSSARY_PROMPTS.enrichSystem)
  const userPrompt =
    args.userPrompt ??
    renderTemplate(loadBundledPrompt(GLOSSARY_PROMPTS.enrichUser), {
      term: args.term,
      text: corpusText(args.chapters, args.maxChars),
    })
  const result = await runPromptWithRetry(ctx, {
    call: args.call,
    model: args.model,
    temperature: args.temperature,
    maxTokens: args.maxTokens,
    maxAttempts: args.maxAttempts,
    systemPrompt,
    userPrompt,
    validate: (content) => {
      const text = content.trim()
      if (text === '') return { ok: false, reason: 'the response was empty' }
      return { ok: true, value: text }
    },
  })
  return {
    description: result.ok ? (result.value ?? '') : '',
    meta: attemptMeta([result]),
  }
}
