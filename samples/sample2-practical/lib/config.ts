import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { type Logger, createConsoleLogger, definePipeline } from '@mt/core'
import {
  type ChapterMap,
  type StatsArtifact,
  chapterNumberOf,
  onlyChapters,
  readChapterMap,
  readStats,
  splitProduced,
} from '@mt/tools'

/**
 * Sample-only path, branch and quality policy.
 *
 * The reusable tools live in `@mt/tools`; this file owns the `books/book2` layout, the
 * `@chapters` / `@schema` aliases and the quality-gated source decision.
 */

export const ROOT = resolve(import.meta.dirname, '..')

/** The real book of this sample (project-relative URI; `mt.json` also aliases it as `@book2`). */
export const BOOK2 = 'md://../../books/book2'

/** Chapters directory of this sample. */
export const CHAPTERS_DIR = resolve(ROOT, 'chapters')

export type Branch = 'translate' | 'preprocess'

export const FORCE_BRANCH_ENV = 'MT_FORCE_BRANCH'
export const SOURCE_ENV = 'MT_SPLIT_BOOK'
export const ROOT_ENV = 'MT_SPLIT_ROOT'
const QUALITY_ROOT_ENV = 'MT_QUALITY_ROOT'
const QUALITY_BOOK_ENV = 'MT_QUALITY_BOOK'

export function chaptersDirOf(): string {
  return CHAPTERS_DIR
}

function bookPath(): string {
  return resolve(ROOT, '../../books/book2')
}

/** Output root URI of the quality/preprocess branch. */
export function qualityRootUri(env: NodeJS.ProcessEnv = process.env): string {
  return env[QUALITY_ROOT_ENV]?.trim() || '@chapters'
}

/** Output root URI of the split stage. */
export function splitRootUri(env: NodeJS.ProcessEnv = process.env): string {
  return env[ROOT_ENV]?.trim() || '@chapters'
}

export function splitSourceUri(env: NodeJS.ProcessEnv = process.env): string {
  return env[SOURCE_ENV]?.trim() || BOOK2
}

/** Filesystem path of a project URI (`@alias`, `md://` relative or an absolute path). */
export function uriPath(uri: string): string {
  const raw = uri.replace(/^md:\/\//, '').trim()
  if (isAbsolute(raw)) return raw
  if (raw === '@chapters') return CHAPTERS_DIR
  if (raw === '@schema') return join(CHAPTERS_DIR, 'schema')
  if (raw === '@book2') return bookPath()
  return resolve(ROOT, raw)
}

export function qualityRootPath(): string {
  return uriPath(qualityRootUri())
}

/** Default stats artefact: `<split root>/schema/stats.json`. */
export function statsPath(): string {
  return join(uriPath(splitRootUri()), 'schema', 'stats.json')
}

/** Split directory URI for the quality/branch output root. */
export function splitUriFor(rootUri: string = qualityRootUri()): string {
  if (rootUri === '@chapters') return 'md://./chapters/split'
  if (rootUri.startsWith('md://')) return `${rootUri.replace(/\/$/, '')}/split`
  return `md://${join(uriPath(rootUri), 'split')}`
}

/** Reads the chapter map of the split stage. */
export function chapterMap(): ChapterMap | undefined {
  return readChapterMap(join(qualityRootPath(), 'schema', 'chapter-map.json'))
}

/** True when the split stage wrote renumbered parts. */
export function hasSplit(): boolean {
  return splitProduced(chapterMap())
}

export function readStatsArtifact(): StatsArtifact {
  return readStats(statsPath())
}

/** Forced branch, or `undefined` when unset/invalid. */
export function forcedBranch(env: NodeJS.ProcessEnv = process.env): Branch | undefined {
  const value = env[FORCE_BRANCH_ENV]?.trim()
  return value === 'translate' || value === 'preprocess' ? value : undefined
}

/**
 * Reads the gate verdict. A missing/unreadable artefact is the identity case: return
 * `undefined` and say so once (the stage simply has not run yet).
 */
export function qualityVerdict(logger: Logger): Branch | undefined {
  const file = join(qualityRootPath(), 'schema', 'quality.json')
  if (!existsSync(file)) {
    logger.warn(`quality: ${file} quality.json missing — using the book source`)
    return undefined
  }
  try {
    const artifact = JSON.parse(readFileSync(file, 'utf-8')) as { verdict?: unknown }
    return artifact.verdict === 'preprocess' ? 'preprocess' : 'translate'
  } catch {
    logger.warn(`quality: ${file} quality.json is not valid JSON — using the book source`)
    return undefined
  }
}

export function bookUriOf(env: NodeJS.ProcessEnv = process.env): string {
  return env[QUALITY_BOOK_ENV]?.trim() || BOOK2
}
/** Source of the quality/preprocess stages: explicit book override, else split/book. */
export function qualitySourceUri(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[QUALITY_BOOK_ENV]?.trim()
  if (override) return override
  return hasSplit() ? splitUriFor() : BOOK2
}

/**
 * Source of the translation stage, decided by the quality gate:
 * forced branch -> missing/invalid quality -> preprocess clean -> split/book.
 */
export function bookSource(logger: Logger = createConsoleLogger()): string {
  const forced = forcedBranch()
  if (forced === 'preprocess') return 'md://./chapters/clean'
  if (forced === 'translate') return hasSplit() ? splitUriFor() : bookUriOf()

  const verdict = qualityVerdict(logger)
  if (verdict === undefined) return bookUriOf()
  if (verdict === 'preprocess') return 'md://./chapters/clean'
  return hasSplit() ? splitUriFor() : bookUriOf()
}

/** `stats.json` ratios for the quality artefact. */
export function readRatioToMean(): Map<number, number> {
  const file = join(qualityRootPath(), 'schema', 'stats.json')
  if (!existsSync(file)) {
    throw new Error(`quality: ${file} missing — run runner:stats first`)
  }
  const stats = JSON.parse(readFileSync(file, 'utf-8')) as {
    chapters: { n: number; ratioToMean: number }[]
  }
  return new Map(stats.chapters.map((chapter) => [chapter.n, chapter.ratioToMean]))
}

/** Proper-noun corpus of the quality gate. */
export function properNounSources(): {
  entities: string
  glossary: string
  names: string
} {
  return {
    entities: join(qualityRootPath(), 'schema', 'entities.json'),
    glossary: join(CHAPTERS_DIR, 'glossary.json'),
    names: join(CHAPTERS_DIR, 'names.json'),
  }
}

/**
 * Keeps only `# Chapter N` / `# Глава N` documents. A book directory may also contain
 * `index.md` and `plot.md`, which are useful metadata but never chapter units.
 */
export function chapterOnly(markdown: unknown): boolean {
  const text = String(markdown)
  if (!/^#\s+(?:Chapter|Глава)\s+\d+\b/m.test(text)) return false
  const only = onlyChapters()
  return only === undefined || only.has(chapterNumberOf(text, 0))
}

/** `flatMap` adapter for book sources: chapter documents pass, `index.md`/`plot.md` drop. */
export function chapterDocs(markdown: unknown): string[] {
  return chapterOnly(markdown) ? [String(markdown)] : []
}

/** Standard entry point of a book stage: read chapter documents and hand them to a batch child. */
export function defineChapterPipeline(id: string, from = '@book2') {
  return definePipeline({ id })
    .from(from)
    .flatMap(async (markdown) => chapterDocs(markdown))
}

export { chapterNumberOf } from '@mt/tools'
