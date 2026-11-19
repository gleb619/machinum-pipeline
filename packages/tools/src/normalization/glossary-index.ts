import { existsSync, readFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { category, defineTool, tool } from '@mt/core'
import { appendMdOutput } from '../core/md-outputs.js'
import { cmpTerm } from './stat-freq.js'
import {
  type Glossary,
  type GlossaryTerm,
  type GlossaryTermType,
  compileTermMatcher,
  countTerms,
} from './term-tagger.js'

/**
 * Book-wide term index derived from `chapters/en` and `chapters/glossary.json` (no LLM).
 *
 * `glossary.json` is book-wide, so a chapter-1 prompt would otherwise carry names that first
 * appear in chapter 14 and a late chapter would get no memory of earlier decisions. The index
 * maps every term to the chapters it actually occurs in; `renderPriorTerms` turns the terms of
 * the chapters before N into a compact prompt block.
 */

/** Index file under `chaptersDir`. */
export const GLOSSARY_INDEX_FILE = 'glossary-index.json'
/** Default cap of the rendered prior-terms block (a late chapter must stay small). */
export const PRIOR_TERMS_MAX = 40
/** Header of the rendered block. */
export const PRIOR_TERMS_HEADER =
  'Terms already established in earlier chapters (keep these renderings):'

/** `chapters/glossary-index.json` shape. */
export interface GlossaryIndex {
  terms: GlossaryIndexTerm[]
}

/** One indexed term: every occurrence chapter, the first one and the total count. */
export interface GlossaryIndexTerm {
  id: string
  term: string
  type: GlossaryTermType
  ru: string
  /** Chapters the term occurs in, ascending. */
  chapters: number[]
  firstChapter: number
  /** Occurrences across the book. */
  count: number
  aliases: string[]
}

/** Glossary entry as the sample edits it: `ignored` is editorial metadata, not a `GlossaryTerm` field. */
export interface GlossaryIndexInputTerm extends GlossaryTerm {
  ignored?: boolean
}

export interface GlossaryIndexInput {
  terms: GlossaryIndexInputTerm[]
  ignored?: string[]
}

export interface BuildGlossaryIndexOptions {
  chaptersDir: string
  glossary: Glossary
}

/** Term state the index cares about: active, human-approved (non-null `ru`). */
export function indexableTerms(glossary: GlossaryIndexInput): GlossaryIndexInputTerm[] {
  const ignoredNames = new Set(glossary.ignored ?? [])
  return glossary.terms.filter(
    (term) =>
      term.ignored !== true &&
      !ignoredNames.has(term.term) &&
      !ignoredNames.has(term.id) &&
      term.term.trim() !== '' &&
      term.ru !== null &&
      term.ru.trim() !== '',
  )
}

function byChapter(left: number, right: number): number {
  return left - right
}

/** Chapter files of `chaptersDir/en`, in numeric order. */
async function chapterFiles(chaptersDir: string): Promise<Array<{ n: number; path: string }>> {
  const dir = join(chaptersDir, 'en')
  const names = await readdir(dir)
  return names
    .map((name) => ({ name, match: /^chapter(\d+)\.md$/.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .map(({ name, match }) => ({ n: Number(match[1]), path: join(dir, name) }))
    .sort((left, right) => byChapter(left.n, right.n))
}

/**
 * Counts every active glossary term in every chapter of `chaptersDir/en` and drops the terms
 * with count 0: a model-proposed name that never occurs in the source never reaches the index.
 */
export async function buildGlossaryIndex(
  options: BuildGlossaryIndexOptions,
): Promise<GlossaryIndex> {
  const active = indexableTerms(options.glossary)
  const activeGlossary: Glossary = { terms: active }
  const matcher = compileTermMatcher(activeGlossary)

  const counts = new Map<string, Map<number, number>>()
  for (const file of await chapterFiles(options.chaptersDir)) {
    const text = await readFile(file.path, 'utf-8')
    for (const [id, count] of countTerms(text, activeGlossary, matcher)) {
      const perChapter = counts.get(id) ?? new Map<number, number>()
      perChapter.set(file.n, count)
      counts.set(id, perChapter)
    }
  }

  const terms: GlossaryIndexTerm[] = []
  for (const term of active) {
    const perChapter = counts.get(term.id)
    if (!perChapter || perChapter.size === 0) continue
    const chapters = [...perChapter.keys()].sort(byChapter)
    let count = 0
    for (const value of perChapter.values()) count += value
    const firstChapter = chapters[0]
    const ru = term.ru
    if (firstChapter === undefined || ru === null) continue
    terms.push({
      id: term.id,
      term: term.term,
      type: term.type,
      ru,
      chapters,
      firstChapter,
      count,
      aliases: [...term.aliases],
    })
  }

  terms.sort(
    (left, right) =>
      byChapter(left.firstChapter, right.firstChapter) ||
      right.count - left.count ||
      cmpTerm(left.term, right.term),
  )
  return { terms }
}

/** `MT_PRIOR_TERMS_MAX` (positive integer), else {@link PRIOR_TERMS_MAX}. */
export function priorTermsMax(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MT_PRIOR_TERMS_MAX)
  return Number.isInteger(n) && n > 0 ? n : PRIOR_TERMS_MAX
}

/** `MT_PRIOR_TERMS=0` disables the prior-terms block. */
export function priorTermsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MT_PRIOR_TERMS?.trim() !== '0'
}

export interface RenderPriorTermsOptions {
  /** Explicit cap; default {@link priorTermsMax} (`MT_PRIOR_TERMS_MAX`, else 40). */
  maxTerms?: number
}

/**
 * Renders the terms first seen before `chapter` as one `term → ru` line each, sorted by first
 * appearance and capped so a late chapter's prompt stays small. Chapter 1 has no prior terms.
 */
export function renderPriorTerms(
  index: GlossaryIndex,
  chapter: number,
  options: RenderPriorTermsOptions = {},
): string {
  const cap = options.maxTerms ?? priorTermsMax()
  if (!(cap > 0)) return ''
  const terms = index.terms
    .filter((term) => term.firstChapter < chapter)
    .slice()
    .sort(
      (left, right) =>
        byChapter(left.firstChapter, right.firstChapter) ||
        right.count - left.count ||
        cmpTerm(left.term, right.term),
    )
    .slice(0, cap)
  if (terms.length === 0) return ''
  return [PRIOR_TERMS_HEADER, ...terms.map((term) => `- ${term.term} → ${term.ru}`)].join('\n')
}

/** Parses an index file; `undefined` when it is absent. Malformed content throws. */
export function readGlossaryIndex(path: string): GlossaryIndex | undefined {
  if (!existsSync(path)) return undefined
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { terms?: unknown }
  if (!Array.isArray(parsed.terms)) {
    throw new Error(`failed to parse glossary index ${path}: expected {"terms": [...]}`)
  }
  return { terms: parsed.terms as GlossaryIndexTerm[] }
}

/** Biome keeps a numeric array on the attribute line while it fits (lineWidth 100). */
export function serializeGlossaryIndex(index: GlossaryIndex): string {
  const json = JSON.stringify(index, null, 2).replace(
    /^( {6})"chapters": \[\n([\s\S]*?)\n\1\]/gm,
    (match, indent: string, body: string) => {
      const values = body.split(/,\n/).map((line) => line.trim())
      const inline = `${indent}"chapters": [${values.join(', ')}]`
      return inline.length <= 100 ? inline : match
    },
  )
  return `${json}\n`
}

export interface CreateGlossaryIndexToolOptions {
  chaptersDir: string
  /** Index filename under the md target root; default {@link GLOSSARY_INDEX_FILE}. */
  indexFile?: string
}

/**
 * Pipeline step: builds the index from the chapter files and the glossary and appends it to the
 * `mdOutputs` write intents (the `md://` target owns the destination). A missing `glossary.json`
 * is not an error (the chain may run before the first extraction): it logs `index: no glossary`
 * and emits nothing.
 */
export function createGlossaryIndexTool(options: CreateGlossaryIndexToolOptions) {
  const chaptersDir = options.chaptersDir
  const indexFile = options.indexFile ?? GLOSSARY_INDEX_FILE
  return defineTool<unknown, unknown>({
    name: 'write-glossary-index',
    version: '1.0.0',
    description:
      'Emits glossary-index.json (per-term occurrence chapters) from chapters/en and glossary.json; no LLM.',
    annotations: [
      tool('TL261', {
        name: 'write-glossary-index',
        description:
          'Emits a per-term chapter occurrence index from the glossary and chapter files.',
        refs: ['UC084'],
      }),
      category(['analyzer']),
    ],
    async invoke(env, ctx) {
      const glossaryPath = join(chaptersDir, 'glossary.json')
      if (!existsSync(glossaryPath)) {
        ctx.run.logger.info('index: no glossary')
        return env
      }
      const glossary = JSON.parse(await readFile(glossaryPath, 'utf-8')) as Glossary
      if (!Array.isArray(glossary.terms)) {
        throw new Error(`failed to parse glossary ${glossaryPath}: expected {"terms": [...]}`)
      }
      const index = await buildGlossaryIndex({ chaptersDir, glossary })
      const multiChapter = index.terms.filter((term) => term.chapters.length > 1).length
      ctx.run.logger.info(`index terms=${index.terms.length} multi-chapter=${multiChapter}`)
      return appendMdOutput(env, {
        name: 'glossary-index',
        subdir: '',
        filename: indexFile,
        content: serializeGlossaryIndex(index),
      })
    },
  })
}

/** Back-compat wrapper: index under the default {@link GLOSSARY_INDEX_FILE}. */
export function writeGlossaryIndexTool(chaptersDir: string) {
  return createGlossaryIndexTool({ chaptersDir })
}
