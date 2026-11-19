import { annotate, definePipeline, defineProcess, useCase } from '@mt/core'
import {
  chapterIndexer,
  collectChapterStats,
  createSplitChapterTool,
  mdOutputEmitter,
  tokenCounterBatchCached,
  wordCounter,
  writeSplitOutputs,
  writeStats,
} from '@mt/tools'
import '@mt/waypoint'
import { defineChapterPipeline, splitRootUri, splitSourceUri, statsPath } from '../lib/config.js'

/**
 * Phase 1 — normalization: raw book → stable numbered chapters. CPU only, no LLM.
 *
 *   books/book2 → extractEn → stats → split
 */

/** Extract `# Chapter N` documents into `chapters/en/chapter<N>.md`. */
export const extractEn = defineChapterPipeline('practical-extract-en')
  .use(chapterIndexer)
  .use(
    mdOutputEmitter({
      name: 'en',
      filename: (meta) => `chapter${meta.chapterNum ?? 0}.md`,
    }),
  )
  .to('md://./chapters/en')

const BATCH = 'batch://?size=100'

/** Measure every chapter (words, tokens, body length) → `schema/stats.json`. */
const statsChild = definePipeline({ id: 'practical-stats-child' })
  .from('batch://members')
  .use(chapterIndexer)
  .use(wordCounter)
  .use(tokenCounterBatchCached)
  .use(collectChapterStats)
  .to('batch://return')

const statsAggregateChild = definePipeline({ id: 'practical-stats-aggregate' })
  .use(writeStats)
  .to('batch://return')

export const stats = defineChapterPipeline('practical-stats')
  .subflow(BATCH, statsChild)
  .subflow(BATCH, statsAggregateChild)
  .to('@schema')

/** Split oversized chapters and assign stable book-wide ids → `schema/chapter-map.json`. */
const splitChapter = createSplitChapterTool({ statsPath })

const splitChild = definePipeline({ id: 'practical-split-child' })
  .from('batch://members')
  .use(chapterIndexer)
  .use(splitChapter)
  .to('batch://return')

const splitAggregateChild = definePipeline({ id: 'practical-split-aggregate' })
  .use(writeSplitOutputs)
  .to('batch://return')

export const split = annotate(
  defineChapterPipeline('practical-split', splitSourceUri())
    .subflow(BATCH, splitChild)
    .subflow(BATCH, splitAggregateChild)
    .to(splitRootUri()),
  useCase('UC056', { name: 'Split large chapters by token count' }),
)

export default defineProcess([extractEn, stats, split], { id: 'practical-normalization' })
