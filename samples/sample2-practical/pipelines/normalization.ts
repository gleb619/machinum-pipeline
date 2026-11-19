import { defineProcess } from '@mt/core'
import extractEn from './stages/extract-en.js'
import split from './stages/split.js'
import stats from './stages/stats.js'

/**
 * Phase 1 — normalization.
 *
 * Turn the raw book into a stable, numbered chapter set: extract the chapter files, measure
 * them, then split anything over the book threshold. CPU only; no LLM is resolved.
 *
 *   books/book2 → extract-en → stats → split
 *
 * `preparation` consumes the artefacts this phase writes (`schema/stats.json`,
 * `schema/chapter-map.json`, plus `chapters/split/` when a chapter was oversized).
 */
export default defineProcess([extractEn, stats, split], { id: 'practical-normalization' })
