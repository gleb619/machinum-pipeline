import { definePipeline } from '@mt/core'
import { chapterIndexer, mdOutputEmitter } from '@mt/tools'
import '@mt/waypoint'
import { chapterOnly } from '../lib/input.js'

/**
 * Extract the real book chapters into `chapters/en/chapter<N>.md` (no LLM).
 *
 * `books/book2` also has `index.md` and `plot.md`; only `# Chapter N` documents become units.
 * The extracted copy is the EN side of `pnpm run lint:parity`.
 */
export default definePipeline({ id: 'practical-extract-en' })
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
