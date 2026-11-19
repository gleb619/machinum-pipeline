import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Logger, createConsoleLogger } from '@mt/core'
import { chapterNumberOf, onlyChapters } from '@mt/tools'
import { BOOK2_URI, qualityRootPath, splitProduced, splitUriFor } from './quality.js'

/** The real book of this sample (project-relative URI; `mt.json` also aliases it as `@book2`). */
export const BOOK2 = BOOK2_URI

/** Branch picked by the quality gate (`chapters/schema/quality.json`). */
export type Branch = 'translate' | 'preprocess'

/** Test seam: force the branch of the quality gate. */
export const FORCE_BRANCH_ENV = 'MT_FORCE_BRANCH'

function forcedBranch(): Branch | undefined {
  const value = process.env[FORCE_BRANCH_ENV]?.trim()
  return value === 'translate' || value === 'preprocess' ? value : undefined
}

/**
 * Reads the gate verdict. A missing/unreadable artefact is the identity case: go to BOOK2 and
 * say so once (the stage simply has not run yet).
 */
function qualityVerdict(logger: Logger): Branch {
  const file = join(qualityRootPath(), 'schema', 'quality.json')
  if (!existsSync(file)) {
    logger.warn(`quality: ${file} missing — using BOOK2`)
    return 'translate'
  }
  try {
    const artifact = JSON.parse(readFileSync(file, 'utf-8')) as { verdict?: unknown }
    return artifact.verdict === 'preprocess' ? 'preprocess' : 'translate'
  } catch {
    logger.warn(`quality: ${file} is not valid JSON — using BOOK2`)
    return 'translate'
  }
}

/**
 * Source of the translation stage, decided by the quality gate:
 *
 * - `MT_FORCE_BRANCH=translate|preprocess` wins (tests, manual overrides);
 * - missing `chapters/schema/quality.json` -> {@link BOOK2} with one WARN;
 * - `preprocess` -> `md://./chapters/clean`;
 * - `translate` -> `md://./chapters/split` when the split stage produced parts, else
 *   {@link BOOK2} (identity case).
 *
 * Step 10 wires this into `pipelines/translation.ts` (`translateChapters`); nothing else calls it yet.
 */
export function bookSource(logger: Logger = createConsoleLogger()): string {
  const branch = forcedBranch() ?? qualityVerdict(logger)
  if (branch === 'preprocess') return 'md://./chapters/clean'
  return splitProduced() ? splitUriFor() : BOOK2
}

/**
 * Keeps only `# Chapter N: ...` documents. `books/book2` also contains `index.md` and `plot.md`,
 * which are useful metadata but never chapter units.
 */
export function chapterOnly(markdown: unknown): boolean {
  const text = String(markdown)
  if (!/^#\s+Chapter\s+\d+\b/m.test(text)) return false
  const only = onlyChapters()
  return only === undefined || only.has(chapterNumberOf(text, 0))
}

/** Chapter number of a markdown chapter (falls back to `fallback`). */
export { chapterNumberOf }
