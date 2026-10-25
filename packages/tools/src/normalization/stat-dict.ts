import { readFile } from 'node:fs/promises'
import { defineTool } from '@mt/core'
import type { Envelope } from '@mt/core'
import { atomicWriteFile, ensureParentDir } from '../core/fs-write.js'
import {
  guessType,
  parseGlossary,
  serializeGlossary,
  slugify,
  uniqueId,
} from './glossary-extractor.js'
import { buildStatFreqReport, cmpTerm } from './stat-freq.js'
import type { StatFreqKind, StatFreqReport } from './stat-freq.js'
import type { Glossary, GlossaryTerm, GlossaryTermType } from './term-tagger.js'

/**
 * Ranked translation dictionary builder (T148).
 *
 * Turns a T147 {@link StatFreqReport} (`meta.statFreq`, a report file, or the envelope text itself)
 * into a glossary-shaped dictionary: candidates above a frequency threshold, type guessed from the
 * term, merged into an existing glossary.
 *
 * Conservative by design — an existing term keeps its `id`, `term`, `type`, `ru`, `aliases` and
 * manual edits: a candidate that matches it is never re-added, renamed or re-typed.
 */

/** One dictionary candidate (a word or an n-gram of the frequency report). */
export interface StatDictCandidate {
  /** The term, as reported (lowercase). */
  term: string
  /** Occurrences in the analysed text. */
  count: number
  /** Which list the term comes from. */
  kind: StatFreqKind
}

/** Options of {@link defineStatDict} and {@link buildStatDict}. */
export interface StatDictOptions {
  /** Minimum frequency for a candidate to enter the dictionary. Default: 3. */
  minCount?: number
  /** Max number of new candidates. Default: 100. */
  topK?: number
  /** Existing glossary file to merge into (a missing file means an empty glossary). */
  glossaryFile?: string
  /** Frequency report file to read (`StatFreqReport` JSON); overrides `meta.statFreq`. */
  reportFile?: string
  /** When set, the merged glossary is also written there as JSON (atomic write). */
  outFile?: string
}

/** Options of {@link selectStatDictCandidates}. */
export interface StatDictSelectOptions {
  /** Minimum frequency for a candidate to enter the dictionary. Default: 3. */
  minCount?: number
  /** Max number of candidates. Default: 100. */
  topK?: number
}

/** True when the value has the shape of a {@link StatFreqReport}. */
export function isStatFreqReport(value: unknown): value is StatFreqReport {
  if (typeof value !== 'object' || value === null) return false
  const report = value as Partial<StatFreqReport>
  return (
    Array.isArray(report.words) &&
    Array.isArray(report.sentences) &&
    Array.isArray(report.ngrams) &&
    Array.isArray(report.top)
  )
}

/**
 * Picks the dictionary candidates of a frequency report.
 *
 * Every term of `top`, `words` and `ngrams` is considered once (the highest count wins), terms
 * below `minCount` are dropped and the rest is ranked by count desc, then term asc (code point).
 */
export function selectStatDictCandidates(
  report: StatFreqReport,
  options: StatDictSelectOptions = {},
): StatDictCandidate[] {
  const minCount = Math.max(1, options.minCount ?? 3)
  const topK = Math.max(1, options.topK ?? 100)
  const byTerm = new Map<string, StatDictCandidate>()

  const add = (term: string, count: number, kind: StatFreqKind): void => {
    const surface = typeof term === 'string' ? term.trim() : ''
    if (surface === '' || typeof count !== 'number') return
    const key = surface.toLowerCase()
    const known = byTerm.get(key)
    if (known && known.count >= count) return
    byTerm.set(key, { term: surface, count, kind })
  }

  for (const entry of report.top ?? []) add(entry.term, entry.count, entry.kind)
  for (const word of report.words ?? []) add(word.word, word.count, 'word')
  for (const ngram of report.ngrams ?? []) add(ngram.ngram, ngram.count, 'ngram')

  return [...byTerm.values()]
    .filter((candidate) => candidate.count >= minCount)
    .sort((a, b) => b.count - a.count || cmpTerm(a.term, b.term))
    .slice(0, topK)
}

/** Capitalises every word (the report terms are lowercase, the type patterns are not). */
function titleCase(term: string): string {
  return term
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** Type of a candidate: `guessType` on the capitalised term, n-grams default to `term`. */
function candidateType(candidate: StatDictCandidate): GlossaryTermType {
  const guessed = guessType(titleCase(candidate.term))
  if (candidate.kind === 'ngram' && guessed === 'character') return 'term'
  return guessed
}

/**
 * Builds the dictionary of a frequency report, merged into an existing glossary.
 *
 * Pure: the input glossary is never mutated. Existing entries are copied verbatim (id, term, type,
 * count, `ru`, aliases, pending) and keep their order; new candidates are appended (count desc,
 * then term asc) with an empty translation and a guessed type. A candidate matching an existing
 * term or alias (case-insensitive) is skipped, and `ignored` terms are never re-added.
 */
export function buildStatDict(
  report: StatFreqReport,
  existing: Glossary = { terms: [] },
  options: StatDictOptions = {},
): Glossary {
  const terms: GlossaryTerm[] = []
  const known = new Set<string>()
  const taken = new Set<string>()

  for (const term of existing.terms ?? []) {
    const copy: GlossaryTerm = { ...term, aliases: [...(term.aliases ?? [])], ru: term.ru ?? null }
    if (term.pending) copy.pending = [...term.pending]
    terms.push(copy)
    taken.add(copy.id)
    known.add(copy.term.trim().toLowerCase())
    for (const alias of copy.aliases) known.add(alias.trim().toLowerCase())
  }

  const ignored = new Set((existing.ignored ?? []).map((s) => s.trim().toLowerCase()))
  for (const candidate of selectStatDictCandidates(report, options)) {
    const key = candidate.term.trim().toLowerCase()
    if (known.has(key) || ignored.has(key)) continue
    known.add(key)
    terms.push({
      id: uniqueId(slugify(candidate.term), taken),
      term: candidate.term,
      type: candidateType(candidate),
      count: candidate.count,
      firstChapter: null,
      ru: null,
      aliases: [],
    })
  }

  return {
    terms,
    ignored: existing.ignored ?? [],
    ...(existing.rejected ? { rejected: existing.rejected } : {}),
  }
}

/** Reads the existing glossary; a missing file means an empty glossary, a broken one is an error. */
async function loadExistingGlossary(path: string | undefined): Promise<Glossary> {
  if (!path) return { terms: [] }
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { terms: [] }
    throw err
  }
  const parsed = parseGlossary(text)
  if (!parsed) {
    throw new Error(`stat-dict: cannot parse glossary file "${path}" (invalid JSON or no "terms")`)
  }
  return parsed
}

/** Reads the frequency report: report file, then `meta.statFreq`, then the envelope text. */
async function loadStatFreqReport(
  env: Envelope<string | string[]>,
  options: StatDictOptions,
): Promise<StatFreqReport> {
  if (options.reportFile) {
    const raw: unknown = JSON.parse(await readFile(options.reportFile, 'utf-8'))
    if (!isStatFreqReport(raw)) {
      throw new Error(`stat-dict: cannot parse report file "${options.reportFile}"`)
    }
    return raw
  }
  const meta = env.meta.statFreq
  if (meta !== undefined) {
    if (!isStatFreqReport(meta)) throw new Error('stat-dict: meta.statFreq is not a StatFreqReport')
    return meta
  }
  const items = env.items ?? (Array.isArray(env.item) ? env.item : [env.item])
  const texts = items.filter((text): text is string => typeof text === 'string')
  return buildStatFreqReport(texts)
}

/**
 * Tool: builds a ranked translation dictionary from a frequency report.
 *
 * The envelope (and its cardinality) is returned untouched; the merged glossary lands in
 * `meta.statDict` and its JSON form in `meta.statDictJson`.
 */
export function defineStatDict(options: StatDictOptions = {}) {
  return defineTool<string | string[], string | string[]>({
    name: 'stat-dict',
    version: '1.0.0',
    mdDescription:
      'Ranked translation dictionary from a stat-freq report (meta.statFreq, a report file or the ' +
      'envelope text): candidates above a frequency threshold, type guess, merged into an existing ' +
      'glossary without touching existing entries. Result in meta.statDict.',
    async invoke(env: Envelope<string | string[]>): Promise<Envelope<string | string[]>> {
      const report = await loadStatFreqReport(env, options)
      const existing = await loadExistingGlossary(options.glossaryFile)
      const glossary = buildStatDict(report, existing, options)
      const json = serializeGlossary(glossary)
      if (options.outFile) {
        await ensureParentDir(options.outFile)
        await atomicWriteFile(options.outFile, json)
      }
      return {
        ...env,
        meta: { ...env.meta, statDict: glossary, statDictJson: json },
      }
    },
  })
}

/** Alias of {@link defineStatDict} (package convention: `create*` factories). */
export const createStatDict = defineStatDict

/** Default builder: candidates from count 3, at most 100 new terms. */
export const statDict = defineStatDict()
