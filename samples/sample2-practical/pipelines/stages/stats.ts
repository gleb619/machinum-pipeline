import { definePipeline } from '@mt/core'
import { chapterIndexer, tokenCounterBatchCached, wordCounter } from '@mt/tools'
import '@mt/waypoint'
import { chapterOnly } from '../../lib/input.js'
import { collectChapterStats, writeStats } from '../../lib/stats.js'

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
const measureChild = definePipeline({ id: 'practical-stats-measure' })
  .from('batch://members')
  .use(chapterIndexer)
  .use(wordCounter)
  .use(tokenCounterBatchCached)
  .use(collectChapterStats)
  .to('batch://return')

const aggregateChild = definePipeline({ id: 'practical-stats-aggregate' })
  .use(writeStats)
  .to('batch://return')

export default definePipeline({ id: 'practical-stats' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .subflow('batch://?size=100', measureChild)
  .subflow('batch://?size=100', aggregateChild)
  .to('@schema')
