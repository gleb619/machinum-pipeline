import { annotate, definePipeline, useCase } from '@mt/core'
import { chapterIndexer } from '@mt/tools'
import '@mt/waypoint'
import { chapterOnly } from '../../lib/input.js'
import {
  collectChapterQuality,
  qualityRootUri,
  qualitySourceUri,
  writeQuality,
} from '../../lib/quality.js'

/**
 * Stage 5 of the book flow: the quality gate (offline, 0 LLM calls).
 *
 *   source (chapters/split when the split stage produced files, else books/book2)
 *     → batch://members → chapterIndexer → collectChapterQuality   (per member)
 *     → batch://group   → writeQuality → chapters/schema/quality.json
 *
 * The verdict is data, not control flow: `lib/input.ts bookSource()` (wired in step 10) reads
 * `quality.json` and picks `chapters/split`/`books/book2` (translate) or `chapters/clean`
 * (preprocess). `MT_FORCE_BRANCH` overrides it for tests. `MT_QUALITY_BOOK` / `MT_QUALITY_ROOT`
 * point the stage at an isolated fixture.
 */
const measureChild = definePipeline({ id: 'practical-quality-child' })
  .from('batch://members')
  .use(chapterIndexer)
  .use(collectChapterQuality)
  .to('batch://return')

const aggregateChild = definePipeline({ id: 'practical-quality-aggregate' })
  .use(writeQuality)
  .to('batch://return')

export default annotate(
  definePipeline({ id: 'practical-quality' })
    .from(qualitySourceUri())
    .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
    .subflow('batch://?size=100', measureChild)
    .subflow('batch://?size=100', aggregateChild)
    .to(qualityRootUri()),
  useCase('UC057', { name: 'Collect chapter quality warnings' }),
)
