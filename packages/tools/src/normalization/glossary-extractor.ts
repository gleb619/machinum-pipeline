import { readFile } from 'node:fs/promises'
import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'
import { buildGlossaryGraph, serializeGlossaryGraph } from './glossary-graph.js'
import type { GlossaryGraph } from './glossary-graph.js'
import {
  CONCEPT_WORDS,
  ITEM_WORDS,
  PLACE_WORDS,
  SKILL_WORDS,
  isCommonWord,
} from './glossary-lexicon.js'
import {
  type LlmGlossaryEntry,
  enrichTermWithLlm,
  extractGlossaryWithLlm,
  mapCategory,
  relateTermWithLlm,
} from './glossary-llm.js'
import { type NerBackend, type NerCandidate, heuristicNerBackend } from './ner-candidates.js'
import type { LlmAttemptMeta, SchemaDocLlmCall } from './schema/llm.js'
import { compileTermMatcher, countTerms, mapProse } from './term-tagger.js'
import type { Glossary, GlossaryChapter, GlossaryTerm, GlossaryTermType } from './term-tagger.js'
import type { ReportedTerm } from './translation-prompt.js'

export type { GlossaryChapter } from './term-tagger.js'

/** One candidate term found in the corpus. */
export interface GlossaryCandidate {
  term: string
  count: number
  firstChapter: number
  type: GlossaryTermType
}

export interface GlossaryExtractOptions {
  /** Min corpus-wide occurrences for a plain (non-bracketed) candidate. Default: 2. */
  minCount?: number
  /** Terms to never propose (merged with `existing.ignored`). */
  ignored?: string[]
  /** Pre-computed candidates (skips the heuristic scan). */
  candidates?: GlossaryCandidate[]
  /** NER candidates seeding the pool (their kind refines a guessed type). */
  ner?: NerCandidate[]
}

/** Best-effort type guess from the term's last word (and the first word for `Mount X`). */
export function guessType(term: string): GlossaryTermType {
  const bracketed = term.startsWith('[')
  const words = term.replace(/^\[|\]$/g, '').split(/\s+/)
  const last = words[words.length - 1] ?? ''
  const first = words[0] ?? ''
  if (PLACE_WORDS.test(last) || first === 'Mount') return 'place'
  if (ITEM_WORDS.test(last)) return 'item'
  if (SKILL_WORDS.test(last)) return 'skill'
  if (CONCEPT_WORDS.test(last)) return 'term'
  return bracketed ? 'term' : 'character'
}

/** Lowercase, hyphenated, ASCII-ish slug of a term. */
export function slugify(term: string): string {
  const s = term
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return s === '' ? 'term' : s
}

const BRACKET = /\[([^[\]\n]{2,60})\]/g
const MULTI =
  /\b[A-Z][a-z]+(?:[-'][A-Z][a-z]+)*(?:\s+(?:(?:of(?:\s+the)?|de|von|van|la|le)\s+)?[A-Z][a-z]+(?:[-'][A-Z][a-z]+)*){1,3}/g
const SINGLE = /\b[A-Z][a-z]{2,}\b/g

function isSentenceStart(line: string, index: number): boolean {
  const before = line.slice(0, index).replace(/["'(\[*_\s]+$/u, '')
  return before === '' || /[.!?:]$/.test(before)
}

function bump(
  map: Map<string, GlossaryCandidate>,
  term: string,
  chapter: number,
  type?: GlossaryTermType,
) {
  const c = map.get(term)
  if (c) {
    c.count++
    c.firstChapter = Math.min(c.firstChapter, chapter)
  } else {
    map.set(term, { term, count: 1, firstChapter: chapter, type: type ?? guessType(term) })
  }
}

/** Short `[Name]` labels; system sentences (`[System: ...]`, `[You gained...!]`) are not terms. */
function bracketTerm(inner: string): string | null {
  const t = inner.trim()
  if (/[:!?.,;]/.test(t) || t.split(/\s+/).length > 5 || !/^[A-Za-z]/.test(t)) return null
  return `[${t}]`
}

/** Extracts glossary candidates from a corpus (heuristic, no LLM). Counts are corpus-wide. */
export function extractCandidates(
  chapters: GlossaryChapter[],
  options: GlossaryExtractOptions = {},
): GlossaryCandidate[] {
  const minCount = options.minCount ?? 2
  const ignored = new Set(options.ignored ?? [])
  const multi = new Map<string, GlossaryCandidate>()
  const bracketed = new Map<string, GlossaryCandidate>()
  const mid = new Map<string, GlossaryCandidate>()
  const capAll = new Map<string, GlossaryCandidate>()
  const lower = new Map<string, number>()

  for (const { chapter, text } of chapters) {
    mapProse(text, (seg) => {
      for (const word of seg.match(/\b[a-z]{3,}\b/g) ?? [])
        lower.set(word, (lower.get(word) ?? 0) + 1)
      const masked: Array<[number, number]> = []
      for (const m of seg.matchAll(BRACKET)) {
        const term = bracketTerm(m[1] ?? '')
        const at = m.index ?? 0
        masked.push([at, at + m[0].length])
        if (term) bump(bracketed, term, chapter)
      }
      for (const m of seg.matchAll(MULTI)) {
        const at = m.index ?? 0
        if (masked.some(([a, b]) => at < b && at + m[0].length > a)) continue
        // trim leading/trailing common words ("The Black Forest" -> "Black Forest")
        const words = m[0].split(/(\s+)/)
        let lo = 0
        let hi = words.length - 1
        while (
          lo <= hi &&
          (isCommonWord(words[lo] ?? '') || /^[A-Z][a-z]+ing$/.test(words[lo] ?? ''))
        )
          lo += 2
        while (hi >= lo && isCommonWord(words[hi] ?? '')) hi -= 2
        if (hi - lo < 2) continue
        const term = words.slice(lo, hi + 1).join('')
        const start = at + words.slice(0, lo).join('').length
        masked.push([start, start + term.length])
        bump(multi, term, chapter)
      }
      for (const m of seg.matchAll(SINGLE)) {
        const at = m.index ?? 0
        const w = m[0]
        if (isCommonWord(w)) continue
        if (masked.some(([a, b]) => at >= a && at < b)) continue
        bump(capAll, w, chapter)
        if (!isSentenceStart(seg, at)) bump(mid, w, chapter)
      }
      return seg
    })
  }

  const out: GlossaryCandidate[] = []
  for (const c of bracketed.values()) out.push(c)
  for (const c of multi.values()) if (c.count >= minCount) out.push(c)
  for (const c of capAll.values()) {
    const midCount = mid.get(c.term)?.count ?? 0
    const low = lower.get(c.term.toLowerCase()) ?? 0
    const repeatedMid = midCount >= 2 && midCount >= low
    const alwaysCap = c.count >= Math.max(3, minCount) && low === 0
    if (repeatedMid || alwaysCap) out.push(c)
  }
  return out.filter((c) => !ignored.has(c.term))
}

/** Glossary type of a NER entity kind. */
function typeOfKind(kind: NerCandidate['kind']): GlossaryTermType {
  switch (kind) {
    case 'person':
      return 'character'
    case 'place':
      return 'place'
    case 'organization':
      return 'term'
    default:
      return 'term'
  }
}

/**
 * Merges the NER candidates into the heuristic pool: a NER entity that the extractor
 * missed becomes a new candidate, and its kind refines a guessed `character` type
 * (a place read as a character becomes a place).
 */
export function seedCandidates(
  candidates: GlossaryCandidate[],
  ner: NerCandidate[] = [],
): GlossaryCandidate[] {
  const byKey = new Map<string, GlossaryCandidate>()
  for (const c of candidates) byKey.set(c.term.toLowerCase(), { ...c })
  for (const n of ner) {
    const key = n.text.toLowerCase()
    const current = byKey.get(key)
    if (!current) {
      byKey.set(key, {
        term: n.text,
        count: n.count ?? 1,
        firstChapter: n.firstChapter ?? 0,
        type: typeOfKind(n.kind),
      })
      continue
    }
    current.count = Math.max(current.count, n.count ?? 1)
    current.firstChapter = Math.min(current.firstChapter, n.firstChapter ?? current.firstChapter)
    if (current.type === 'character') {
      const refined = typeOfKind(n.kind)
      if (refined !== 'term' || n.kind === 'organization') current.type = refined
    }
  }
  return [...byKey.values()]
}

/** Unique id from a slug base: `base`, `base-2`, `base-3`, … (`taken` is updated). */
export function uniqueId(base: string, taken: Set<string>): string {
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

/** Recomputes `count` / `firstChapter` of every term from the corpus (pure). */
export function recountGlossary(glossary: Glossary, chapters: GlossaryChapter[]): Glossary {
  const matcher = compileTermMatcher(glossary)
  const totals = new Map<string, number>()
  const first = new Map<string, number>()
  for (const { chapter, text } of [...chapters].sort((a, b) => a.chapter - b.chapter)) {
    for (const [id, n] of countTerms(text, glossary, matcher)) {
      totals.set(id, (totals.get(id) ?? 0) + n)
      if (!first.has(id)) first.set(id, chapter)
    }
  }
  return {
    ...glossary,
    terms: glossary.terms.map((t) => ({
      ...t,
      count: totals.get(t.id) ?? 0,
      firstChapter: first.get(t.id) ?? t.firstChapter ?? null,
    })),
  }
}

/**
 * Builds (or updates) the glossary for a corpus.
 *
 * - Existing entries are kept as-is (order, `id`, `type`, `ru`, `aliases`, manual edits and
 *   human-added terms); only `count` / `firstChapter` are recomputed from the corpus.
 * - New candidates are appended (count desc), ids are unique.
 * - Terms listed in `existing.ignored` are never re-added.
 */
export function buildGlossary(
  chapters: GlossaryChapter[],
  existing?: Glossary,
  options: GlossaryExtractOptions = {},
): Glossary {
  const ignored = [...new Set([...(existing?.ignored ?? []), ...(options.ignored ?? [])])]
  const known = new Set<string>()
  const taken = new Set<string>()
  const terms: GlossaryTerm[] = []
  for (const t of existing?.terms ?? []) {
    terms.push({ ...t, aliases: [...(t.aliases ?? [])], ru: t.ru ?? null })
    taken.add(t.id)
    known.add(t.term.trim().toLowerCase())
    for (const a of t.aliases ?? []) known.add(a.trim().toLowerCase())
  }
  const scanned =
    options.candidates ?? extractCandidates(chapters, { minCount: options.minCount, ignored })
  const fresh = seedCandidates(scanned, options.ner)
    .filter((c) => !known.has(c.term.trim().toLowerCase()))
    .filter((c) => !ignored.includes(c.term))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
  for (const c of fresh) {
    terms.push({
      id: uniqueId(slugify(c.term), taken),
      term: c.term,
      type: c.type,
      count: c.count,
      firstChapter: c.firstChapter,
      ru: null,
      aliases: [],
    })
  }

  // Recount every entry with the tagger's own matching rules (existing + new, consistent).
  return recountGlossary(
    {
      terms,
      ignored,
      ...(existing?.rejected && existing.rejected.length > 0
        ? { rejected: existing.rejected }
        : {}),
    },
    chapters,
  )
}

/**
 * Merges the entries reported by the model into a glossary (pure).
 *
 * - A term that is already in the glossary keeps its `ru`; its `type` is only refined when
 *   the term is new in this run (`protectedIds` holds the ids of the reused terms). A locked
 *   term is never refined (`type`/`ru` stay exactly as the human fixed them).
 * - An unknown term is appended (reported type/description applied, id via `slugify`).
 * - `references` of an entry point to the terms that exist in the glossary.
 */
export function mergeExtractedEntries(
  glossary: Glossary,
  entries: LlmGlossaryEntry[],
  protectedIds: Set<string> = new Set(),
): Glossary {
  const taken = new Set<string>()
  const bySurface = new Map<string, GlossaryTerm>()
  const terms: GlossaryTerm[] = []
  for (const t of glossary.terms) {
    const copy: GlossaryTerm = { ...t, aliases: [...(t.aliases ?? [])] }
    terms.push(copy)
    taken.add(copy.id)
    bySurface.set(copy.term.trim().toLowerCase(), copy)
    for (const a of copy.aliases) bySurface.set(a.trim().toLowerCase(), copy)
  }
  const ignored = new Set((glossary.ignored ?? []).map((s) => s.toLowerCase()))
  for (const entry of entries) {
    const key = entry.name.trim().toLowerCase()
    if (key === '' || ignored.has(key)) continue
    const match = bySurface.get(key)
    if (match) {
      if (entry.description !== '' && !match.description) match.description = entry.description
      if (!match.locked && !protectedIds.has(match.id) && entry.category !== '') {
        match.type = mapCategory(entry.category)
      }
      const merged = [...new Set([...(match.references ?? []), ...entry.references])]
      if (merged.length > 0) match.references = merged
      continue
    }
    const term: GlossaryTerm = {
      id: uniqueId(slugify(entry.name), taken),
      term: entry.name,
      type: mapCategory(entry.category),
      count: 0,
      firstChapter: null,
      ru: null,
      aliases: [],
      ...(entry.description !== '' ? { description: entry.description } : {}),
      ...(entry.references.length > 0 ? { references: [...entry.references] } : {}),
    }
    terms.push(term)
    bySurface.set(key, term)
  }
  return { ...glossary, terms }
}

/** Relations between the glossary terms: term name -> related term names. */
export type GlossaryRelations = Map<string, string[]>

/**
 * Heuristic relations: two terms that appear in the same sentence of the corpus are
 * related. The most frequent neighbours win when a term has too many of them.
 */
export function coOccurrenceRelations(
  chapters: GlossaryChapter[],
  glossary: Glossary,
  maxPerTerm = 12,
): GlossaryRelations {
  const matcher = compileTermMatcher(glossary)
  const byId = new Map(glossary.terms.map((t) => [t.id, t.term]))
  const counts = new Map<string, Map<string, number>>()
  for (const { text } of chapters) {
    for (const segment of text.split('\n').flatMap((line) => line.split(/[.!?]+\s+/))) {
      const found = new Set<string>()
      for (const [id] of countTerms(segment, glossary, matcher)) found.add(id)
      if (found.size < 2) continue
      const names = [...found].map((id) => byId.get(id)).filter((n): n is string => !!n)
      for (const a of names) {
        const neighbours = counts.get(a) ?? new Map<string, number>()
        for (const b of names) {
          if (a === b) continue
          neighbours.set(b, (neighbours.get(b) ?? 0) + 1)
        }
        counts.set(a, neighbours)
      }
    }
  }
  const relations: GlossaryRelations = new Map()
  for (const [name, neighbours] of counts) {
    const top = [...neighbours.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxPerTerm)
      .map(([other]) => other)
    relations.set(name, top)
  }
  return relations
}

/**
 * Adds the relations to the glossary terms (pure): `references` holds the names of the
 * related terms that exist in the glossary (sorted, unique).
 */
export function applyRelations(glossary: Glossary, relations: GlossaryRelations): Glossary {
  const byName = new Map<string, string>()
  for (const t of glossary.terms) byName.set(t.term.trim().toLowerCase(), t.id)
  const terms = glossary.terms.map((term) => {
    const extra = relations.get(term.term) ?? []
    const merged = new Set([...(term.references ?? []), ...extra])
    const kept = [...merged]
      .map((name) => name.trim())
      .filter((name) => name !== '' && byName.has(name.toLowerCase()))
      .filter((name) => name.toLowerCase() !== term.term.trim().toLowerCase())
      .sort((a, b) => a.localeCompare(b))
    const { references: _previous, ...rest } = term
    return kept.length > 0 ? { ...rest, references: kept } : rest
  })
  return { ...glossary, terms }
}

const TYPE_ORDER: GlossaryTermType[] = ['character', 'place', 'item', 'skill', 'term']

/** Sorts the terms by category then name (like the machinum-llm `joinNames`). */
export function sortGlossary(glossary: Glossary): Glossary {
  const rank = (type: GlossaryTermType): number => {
    const index = TYPE_ORDER.indexOf(type)
    return index === -1 ? TYPE_ORDER.length : index
  }
  return {
    ...glossary,
    terms: [...glossary.terms].sort(
      (a, b) => rank(a.type) - rank(b.type) || a.term.localeCompare(b.term),
    ),
  }
}

/**
 * Conservative auto-merge of model-reported terms (see {@link parseReportedTerms}) into a glossary.
 * Pure: returns a new glossary, the input is never mutated.
 *
 * - A reported surface form matching an existing term or alias (case-insensitive) NEVER changes
 *   `ru` — a differing value is queued in `pending` (skipped when equal, already pending, in
 *   `rejected`, or the term is locked: a locked term is never re-proposed, its `ru` is final).
 * - Unknown terms are appended as new entries (reported `type`/`ru` applied, id via `slugify`)
 *   unless listed in `ignored`; a `ru` value in `rejected` is stored as `null` instead.
 */
export function mergeReportedTerms(existing: Glossary, reported: ReportedTerm[]): Glossary {
  const rejected = new Set(existing.rejected ?? [])
  const ignored = new Set((existing.ignored ?? []).map((s) => s.toLowerCase()))
  const taken = new Set<string>()
  const bySurface = new Map<string, GlossaryTerm>()
  const terms: GlossaryTerm[] = []
  for (const t of existing.terms) {
    const copy: GlossaryTerm = { ...t, aliases: [...(t.aliases ?? [])] }
    terms.push(copy)
    taken.add(copy.id)
    bySurface.set(copy.term.trim().toLowerCase(), copy)
    for (const a of copy.aliases) bySurface.set(a.trim().toLowerCase(), copy)
  }
  for (const r of reported) {
    const match = bySurface.get(r.term.toLowerCase())
    if (match) {
      if (match.locked) continue
      if (r.ru === null || r.ru === (match.ru ?? null) || rejected.has(r.ru)) continue
      const pending = match.pending ?? []
      if (!pending.includes(r.ru)) match.pending = [...pending, r.ru]
      continue
    }
    if (ignored.has(r.term.toLowerCase())) continue
    const term: GlossaryTerm = {
      id: uniqueId(slugify(r.term), taken),
      term: r.term,
      type: r.type ?? guessType(r.term),
      count: 0,
      firstChapter: null,
      ru: r.ru !== null && !rejected.has(r.ru) ? r.ru : null,
      aliases: [],
    }
    terms.push(term)
    bySurface.set(r.term.toLowerCase(), term)
  }
  return {
    terms,
    ignored: existing.ignored ?? [],
    ...(existing.rejected ? { rejected: existing.rejected } : {}),
  }
}

/** Parses a `glossary.json` text; `undefined` for empty or malformed input. */
export function parseGlossary(json: string): Glossary | undefined {
  try {
    const raw = JSON.parse(json) as Partial<Glossary>
    if (!raw || !Array.isArray(raw.terms)) return undefined
    return {
      terms: raw.terms,
      ...(raw.ignored ? { ignored: raw.ignored } : {}),
      ...(raw.rejected && raw.rejected.length > 0 ? { rejected: raw.rejected } : {}),
    }
  } catch {
    return undefined
  }
}

/** Reads and parses a `glossary.json` file; `undefined` when absent or malformed. */
export async function readGlossaryFile(path: string): Promise<Glossary | undefined> {
  try {
    return parseGlossary(await readFile(path, 'utf-8'))
  } catch {
    return undefined
  }
}

/** Stable pretty JSON for `glossary.json` (human-editable). */
export function serializeGlossary(glossary: Glossary): string {
  return `${JSON.stringify(
    { terms: glossary.terms, ignored: glossary.ignored ?? [], rejected: glossary.rejected ?? [] },
    null,
    2,
  )}\n`
}

/** Chapter number from a `# Chapter N` heading, else the fallback. */
export function chapterNumberOf(md: string, fallback: number): number {
  const n = /^#\s*Chapter\s+(\d+)/im.exec(md)?.[1]
  return n ? Number(n) : fallback
}

/** Relation enrichment through the NameRelations prompt (needs an LLM backend). */
export interface GlossaryRelationsOptions {
  /** Analyse the relations of the terms without references. Default: `false`. */
  enabled?: boolean
  /** Max terms analysed. Default: 8. */
  maxTerms?: number
}

/** Term enrichment through the GlossaryEnrich prompt (needs an LLM backend). */
export interface GlossaryEnrichOptions {
  /** Describe the new terms. Default: `false`. */
  enabled?: boolean
  /** Max terms described. Default: 5. */
  maxTerms?: number
}

export interface GlossaryExtractorToolOptions extends GlossaryExtractOptions {
  /** Loads the existing glossary (e.g. from `chapters/glossary.json`). */
  load?: () => Promise<Glossary | undefined> | Glossary | undefined
  /** LLM backend (e.g. `pickLlmTool().schemaCall`); without it the extractor stays offline. */
  call?: SchemaDocLlmCall
  model?: string
  temperature?: number
  maxTokens?: number
  /** Loop-guard budget: LLM calls per stage before the deterministic fallback. */
  maxAttempts?: number
  /** NER backend seeding the candidates. Default: the built-in heuristic one. */
  nerBackend?: NerBackend
  /** Relation enrichment through the NameRelations prompt. */
  relations?: GlossaryRelationsOptions
  /** Term enrichment through the GlossaryEnrich prompt. */
  enrich?: GlossaryEnrichOptions
  /** Add the co-occurrence relations of the corpus. Default: `true`. */
  coOccurrence?: boolean
}

/**
 * Tool: builds/updates the glossary from `env.items` (batched corpus) or `env.item`.
 * Item untouched; result in `meta.glossary` (+ `meta.glossaryJson`, `meta.glossaryGraph`,
 * `meta.glossaryGraphJson`, `meta.chapterNums`).
 *
 * With an LLM backend the corpus is analysed with the bundled `glossary.*` prompts: the
 * terms of the previous glossary are reused (their `ru` / `type` win), only the new
 * candidates are extracted, and the relations of the terms are built from the model
 * answer. Any LLM failure falls back to the heuristic glossary.
 */
export function createGlossaryExtractor(options: GlossaryExtractorToolOptions = {}) {
  return defineTool<string | string[], string | string[]>({
    name: 'glossary-extractor',
    version: '2.0.0',
    mdDescription:
      'Glossary extraction (heuristic candidates + NER seeding, LLM extraction with the ' +
      'bundled glossary prompts, reuse of the terms of the previous glossary, relation ' +
      'graph). Stores `meta.glossary`, `meta.glossaryJson` and `meta.glossaryGraph`.',
    async invoke(
      env: Envelope<string | string[]>,
      ctx: ToolContext,
    ): Promise<Envelope<string | string[]>> {
      const inputs = (env.items ?? [env.item]).flat()
      const chapterNums = inputs.map((t, i) => chapterNumberOf(t, i + 1))
      const chapters: GlossaryChapter[] = inputs.map((text, i) => ({
        chapter: chapterNums[i] ?? i + 1,
        text,
      }))
      const existing = await options.load?.()

      // --- candidates: heuristic scan + NER seeding -------------------------------------
      const ignored = [...new Set([...(existing?.ignored ?? []), ...(options.ignored ?? [])])]
      const scanned =
        options.candidates ??
        extractCandidates(chapters, {
          minCount: options.minCount,
          ignored,
        })
      const backend = options.nerBackend ?? heuristicNerBackend
      const ner = options.ner ?? (await backend.extract(chapters))
      const pool = seedCandidates(scanned, ner)

      // --- reuse: the terms of the previous glossary are never re-extracted -------------
      const knownNames = new Set(
        (existing?.terms ?? [])
          .flatMap((t) => [t.term, ...(t.aliases ?? [])])
          .map((s) => s.trim().toLowerCase()),
      )
      const protectedIds = new Set((existing?.terms ?? []).map((t) => t.id))
      const freshNames = pool
        .filter((c) => !knownNames.has(c.term.trim().toLowerCase()))
        .filter((c) => !ignored.includes(c.term))
        .map((c) => c.term)

      // --- LLM extraction (optional) ----------------------------------------------------
      let entries: LlmGlossaryEntry[] = []
      let llmMeta: LlmAttemptMeta | undefined
      if (options.call) {
        const result = await extractGlossaryWithLlm(ctx, {
          call: options.call,
          model: options.model,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          maxAttempts: options.maxAttempts,
          chapters,
          known: (existing?.terms ?? []).map((t) => t.term),
          candidates: freshNames,
        })
        entries = result.entries
        llmMeta = result.meta
      }

      // --- merge --------------------------------------------------------------------------
      let glossary = buildGlossary(chapters, existing, {
        minCount: options.minCount,
        ignored,
        candidates: pool,
      })
      glossary = mergeExtractedEntries(glossary, entries, protectedIds)

      // --- relations ----------------------------------------------------------------------
      // The relations the model reported with the entries (semantic ones).
      const relations: GlossaryRelations = new Map()
      for (const term of glossary.terms) {
        if (term.references && term.references.length > 0) {
          relations.set(term.term, [...term.references])
        }
      }

      // The relations of the terms the model did not relate yet (NameRelations prompt).
      if (options.call && options.relations?.enabled) {
        const maxTerms = options.relations.maxTerms ?? 8
        const pending = glossary.terms.filter((t) => !relations.has(t.term)).slice(0, maxTerms)
        for (const term of pending) {
          const result = await relateTermWithLlm(ctx, {
            call: options.call,
            model: options.model,
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            maxAttempts: options.maxAttempts,
            term: term.term,
            description: term.description,
            similarNames: glossary.terms
              .filter((t) => t.id !== term.id)
              .slice(0, 20)
              .map((t) => t.term),
          })
          const current = relations.get(term.term) ?? []
          relations.set(term.term, [
            ...current,
            ...result.relations.flatMap((relation) => relation.relatedNames),
          ])
        }
      }

      // The terms that share a sentence of the corpus (heuristic relations).
      const coOccurrences: GlossaryRelations = new Map()
      if (options.coOccurrence !== false) {
        for (const [name, neighbours] of coOccurrenceRelations(chapters, glossary)) {
          coOccurrences.set(name, neighbours)
          relations.set(name, [...(relations.get(name) ?? []), ...neighbours])
        }
      }
      glossary = applyRelations(glossary, relations)

      // --- enrichment ---------------------------------------------------------------------
      if (options.call && options.enrich?.enabled) {
        const maxTerms = options.enrich.maxTerms ?? 5
        const pending = glossary.terms
          .filter((t) => !protectedIds.has(t.id) && !t.description)
          .slice(0, maxTerms)
        for (const term of pending) {
          const result = await enrichTermWithLlm(ctx, {
            call: options.call,
            model: options.model,
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            maxAttempts: options.maxAttempts,
            term: term.term,
            chapters,
          })
          if (result.description !== '') term.description = result.description
        }
      }

      // --- finalise ------------------------------------------------------------------------
      glossary = recountGlossary(glossary, chapters)
      glossary = sortGlossary(glossary)
      const graph: GlossaryGraph = buildGlossaryGraph(glossary, coOccurrences)
      return {
        ...env,
        meta: {
          ...env.meta,
          glossary,
          glossaryJson: serializeGlossary(glossary),
          glossaryGraph: graph,
          glossaryGraphJson: serializeGlossaryGraph(graph),
          chapterNums,
          ...(llmMeta ? { glossaryLlm: llmMeta } : {}),
        },
      }
    },
  })
}

export const glossaryExtractor = createGlossaryExtractor()
