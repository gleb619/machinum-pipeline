import { definePipeline } from '@mt/core'
import { bookCompiler } from '@mt/tools'
import '@mt/waypoint'
import { sortChapters, withBookTitle } from '../lib/outputs.js'

/**
 * Assemble the translated book with `bookCompiler` → `book://`.
 *
 *   chapters/ru → batch(1000) → sort by chapter number → bookCompiler → chapters/book/
 *
 * `book://` writes `book.md` (frontmatter, table of contents, chapters) and `book.json`
 * (TOC + completeness warnings: gaps, duplicates, ordering, empty bodies). The md source
 * discovers files in name order (`chapter1`, `chapter10`, ...), hence `sortChapters`.
 */
export default definePipeline({ id: 'practical-assemble' })
  .from('@ru')
  .batch(1000)
  .use(sortChapters)
  .use(withBookTitle('The Quiet Frequency — Russian draft'))
  .use(bookCompiler)
  .to('book://./chapters/book')
