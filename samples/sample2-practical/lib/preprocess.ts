import { join } from 'node:path'
import {
  type Glossary,
  type PreprocessPlan,
  loadGlossaryOrEmpty,
  readPreprocessPlan as readPlan,
} from '@mt/tools'
import { CHAPTERS_DIR, forcedBranch, qualityRootPath } from './config.js'

/** The single log line of the no-op branch. */
export const SKIP_LOG = 'preprocess skipped verdict=translate'

/** Reads the branch decision and the per-chapter verdicts from `schema/quality.json`. */
export function readPreprocessPlan(): PreprocessPlan {
  return readPlan(join(qualityRootPath(), 'schema', 'quality.json'), {
    force: forcedBranch() === 'preprocess',
  })
}

/** Reads `chapters/glossary.json`; a missing/invalid file means "no glossary" (typos only). */
export function loadPreprocessGlossary(): Glossary {
  return loadGlossaryOrEmpty(CHAPTERS_DIR)
}
