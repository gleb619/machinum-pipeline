import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Logger, createConsoleLogger, definePipeline } from '@mt/core'
import { chapterNumberOf, onlyChapters } from '@mt/tools'
import { type BookPathsOptions, bookUriOf, cleanUriFor, envOf } from './paths.js'
import { qualityRootPath } from './quality.js'
import { type SplitPathsOptions, splitProduced, splitUriFor } from './split.js'

export type { Branch } from './paths.js'
export { chapterNumberOf } from '@mt/tools'

/** Test seam: force the branch of the quality gate. */
export const FORCE_BRANCH_ENV = 'MT_FORCE_BRANCH'

/**
 * Branch forced by `MT_FORCE_BRANCH` (tests, manual overrides); `undefined` when unset or
 * invalid. Pass `options.env` to keep tests free of `process.env` mutation.
 */
export function forcedBranch(options?: BookPathsOptions): 'translate' | 'preprocess' | undefined {
  const env = options ? envOf(options) : process.env
  const value = env[options?.forceBranchEnv ?? FORCE_BRANCH_ENV]?.trim()
  return value === 'translate' || value === 'preprocess' ? value : undefined
}

/**
 * Reads the gate verdict. A missing/unreadable artefact is the identity case: return
 * `undefined` and say so once (the stage simply has not run yet).
 */
export function qualityVerdict(
  options: SplitPathsOptions,
  logger: Logger,
): 'translate' | 'preprocess' | undefined {
  const file = join(qualityRootPath(options), 'schema', 'quality.json')
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

export interface BookSourceOptions extends SplitPathsOptions {
  /** URI of the cleaned branch; defaults to `<output root>/clean`. */
  cleanUri?: string
}

/**
 * Source of the translation stage, decided by the quality gate:
 *
 * - `MT_FORCE_BRANCH=translate|preprocess` wins (tests, manual overrides);
 * - missing/invalid `schema/quality.json` -> the book URI with one WARN;
 * - `preprocess` -> `chapters/clean` ({@link cleanUriFor});
 * - `translate` -> the split directory when the split stage produced parts, else the book URI.
 */
export function createBookSource(options: BookSourceOptions): (logger?: Logger) => string {
  return (logger: Logger = createConsoleLogger()): string => {
    const forced = forcedBranch(options)
    if (forced === 'preprocess') return options.cleanUri ?? cleanUriFor(options)
    if (forced === 'translate') {
      return splitProduced(options) ? splitUriFor(options) : bookUriOf(options)
    }

    const verdict = qualityVerdict(options, logger)
    if (verdict === undefined) return bookUriOf(options)
    if (verdict === 'preprocess') return options.cleanUri ?? cleanUriFor(options)
    return splitProduced(options) ? splitUriFor(options) : bookUriOf(options)
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

/**
 * The standard entry point of a book stage: read chapter documents from `from` and hand them
 * to a batch child (`.subflow('batch://?size=N', child)`).
 */
export function defineChapterPipeline(id: string, from = '@book2') {
  return definePipeline({ id })
    .from(from)
    .flatMap(async (markdown) => chapterDocs(markdown))
}
