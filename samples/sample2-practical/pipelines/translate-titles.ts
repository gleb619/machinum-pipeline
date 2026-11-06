import { definePipeline } from '@mt/core'
import type { LlmRequest } from '@mt/tools'
import {
  chaptersToTitleInputs,
  createGlossaryTitleTranslator,
  createTitleTranslator,
} from '@mt/tools'
import '@mt/waypoint'
import { join } from 'node:path'
import { chapterOnly } from '../lib/input.js'
import { ROOT, pickFor } from '../lib/llm.js'
import { writeTitles } from '../lib/outputs.js'

/**
 * Translate the chapter titles in batches of five.
 *
 *   books/book2 → filter chapters → batch(5) → title translator → chapters/titles.json
 *
 * `chapters/titles.json` is merged chapter-by-chapter, so a partial re-run (`MT_ONLY_CHAPTERS`)
 * never drops the titles of the other chapters.
 */
const CHAPTERS = join(ROOT, 'chapters')

const llm = pickFor('titles', (req: LlmRequest) =>
  (req.messages.at(-1)?.content ?? '').replace(/[A-Za-z]+/g, 'слово'),
)

export default definePipeline({ id: 'practical-translate-titles' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .batch(5)
  .use(chaptersToTitleInputs)
  .use(
    createTitleTranslator({
      translate: createGlossaryTitleTranslator({ call: llm.schemaCall, chaptersDir: CHAPTERS }),
    }),
  )
  .use(writeTitles)
  .to('@chapters')
