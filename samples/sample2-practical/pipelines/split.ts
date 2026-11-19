import { annotate, definePipeline, useCase } from '@mt/core'
import { chapterIndexer } from '@mt/tools'
import '@mt/waypoint'
import { chapterOnly } from '../lib/input.js'
import { splitChapter, splitRootUri, splitSourceUri, writeSplitOutputs } from '../lib/split-map.js'

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
const measureChild = definePipeline({ id: 'practical-split-child' })
  .from('batch://members')
  .use(chapterIndexer)
  .use(splitChapter)
  .to('batch://return')

const aggregateChild = definePipeline({ id: 'practical-split-aggregate' })
  .use(writeSplitOutputs)
  .to('batch://return')

export default annotate(
  definePipeline({ id: 'practical-split' })
    .from(splitSourceUri())
    .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
    .subflow('batch://?size=100', measureChild)
    .subflow('batch://?size=100', aggregateChild)
    .to(splitRootUri()),
  useCase('UC056', { name: 'Split large chapters by token count' }),
)
