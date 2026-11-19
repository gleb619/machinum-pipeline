import { annotate, definePipeline, defineProcess, useCase } from '@mt/core'
import { chapterIndexer, mdOutputEmitter, tokenCounterBatchCached, wordCounter } from '@mt/tools'
import '@mt/waypoint'
import { chapterOnly } from '../lib/input.js'
import { splitChapter, splitRootUri, splitSourceUri, writeSplitOutputs } from '../lib/split-map.js'
import { collectChapterStats, writeStats } from '../lib/stats.js'

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

/**
 * Extract the real book chapters into `chapters/en/chapter<N>.md` (no LLM).
 *
 * `books/book2` also has `index.md` and `plot.md`; only `# Chapter N` documents become units.
 * The extracted copy is the EN side of `pnpm run lint:parity`.
 */
export const extractEn = definePipeline({ id: 'practical-extract-en' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .use(chapterIndexer)
  .use(
    mdOutputEmitter({
      name: 'en',
      filename: (meta) => `chapter${meta.chapterNum ?? 0}.md`,
    }),
  )
  .to('md://./chapters/en')

/**
 * Stage 1 of the book flow: measure every chapter (no LLM, deterministic).
 *
 *   books/book2 chapters → batch://members → chapterIndexer → wordCounter →
 *   tokenCounterBatchCached → collectChapterStats    (per member, patched back)
 *   → batch://group → writeStats → chapters/schema/stats.json
 *
 * The measure step commits per-member variables; the aggregate step then groups the patched
 * members again and emits one artefact. `bodyChars` excludes the leading `# ` H1 line (see
 * `lib/stats.ts`).
 */
const statsMeasureChild = definePipeline({ id: 'practical-stats-measure' })
  .from('batch://members')
  .use(chapterIndexer)
  .use(wordCounter)
  .use(tokenCounterBatchCached)
  .use(collectChapterStats)
  .to('batch://return')

const statsAggregateChild = definePipeline({ id: 'practical-stats-aggregate' })
  .use(writeStats)
  .to('batch://return')

export const stats = definePipeline({ id: 'practical-stats' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .subflow('batch://?size=100', statsMeasureChild)
  .subflow('batch://?size=100', statsAggregateChild)
  .to('@schema')

/**
 * Stage 1b of the book flow: split oversized chapters and assign stable book-wide ids.
 *
 *   books/book2 chapters → batch://members → chapterIndexer → splitChapter (no LLM)
 *   → batch://group → writeSplitOutputs → chapters/schema/chapter-map.json
 *                                        (+ chapters/split/chapter<id>.md when a split happened)
 *
 * Requires `runner:stats` first: the split target is `floor(schema/stats.json book.threshold)`.
 * When nothing is oversized no chapter files are written — the identity map keeps the source
 * directory in charge (see `lib/split-map.ts`). `MT_SPLIT_BOOK` / `MT_SPLIT_ROOT` override the
 * source and output roots for isolated fixture runs; production uses `@book2` → `@chapters`.
 */
const splitMeasureChild = definePipeline({ id: 'practical-split-child' })
  .from('batch://members')
  .use(chapterIndexer)
  .use(splitChapter)
  .to('batch://return')

const splitAggregateChild = definePipeline({ id: 'practical-split-aggregate' })
  .use(writeSplitOutputs)
  .to('batch://return')

export const split = annotate(
  definePipeline({ id: 'practical-split' })
    .from(splitSourceUri())
    .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
    .subflow('batch://?size=100', splitMeasureChild)
    .subflow('batch://?size=100', splitAggregateChild)
    .to(splitRootUri()),
  useCase('UC056', { name: 'Split large chapters by token count' }),
)

export default defineProcess([extractEn, stats, split], { id: 'practical-normalization' })
