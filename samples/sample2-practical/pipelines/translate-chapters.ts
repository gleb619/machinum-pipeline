import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { definePipeline } from '@mt/core'
import type { LlmRequest } from '@mt/tools'
import {
  chapterPairsLinter,
  chaptersToTitleInputs,
  createChapterBodyTranslator,
  createGlossaryTitleTranslator,
  createTitleTranslator,
  createTranslateOutputs,
  translateConcurrency,
} from '@mt/tools'
import '@mt/waypoint'
import { chapterOnly } from '../lib/input.js'
import { ROOT, pickFor } from '../lib/llm.js'
import { tagWithGlossary } from '../lib/outputs.js'

/**
 * Translate the whole book body, line by line, with parity linting.
 *
 *   books/book2 → tag glossary terms → batch(5) → titles → per-line body translation
 *               → chapterPairsLinter → chapters/ru/chapter<N>.md + chapters/titles.json
 *
 * `tagWithGlossary` makes the terms of `chapters/glossary.json` visible to the prompt builder;
 * `createChapterBodyTranslator` also reads `chapters/schema/chapter<N>.summary.md` as context.
 * A line whose reply breaks parity throws a retryable error and is retried; passed lines are
 * memoised. Run `summary.ts` and `glossary.ts` first to give the prompts real context.
 *
 * `MT_ONLY_CHAPTERS=1,2` narrows the run; `MT_TRANSLATE_PROMPT_LOG=<file>` records every prompt
 * with the mock backend (the tests assert on that log). The default backend is the offline mock.
 */
const CHAPTERS = join(ROOT, 'chapters')

let mockCalls = 0
function mockAnswer(req: LlmRequest): string {
  const system = req.messages.find((message) => message.role === 'system')?.content ?? ''
  const user = [...req.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
  const log = process.env.MT_TRANSLATE_PROMPT_LOG
  if (log) appendFileSync(log, `${JSON.stringify({ system, user })}\n`)
  mockCalls += 1
  if (process.env.MT_MOCK_FLAKY === '1' && mockCalls === 3) return ''
  return user.replace(/[A-Za-z]+/g, 'слово')
}

const llm = pickFor('translate', mockAnswer)

export default definePipeline({ id: 'practical-translate-chapters' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .batch(5)
  .use(tagWithGlossary(CHAPTERS))
  .use(chaptersToTitleInputs)
  .use(
    createTitleTranslator({
      translate: createGlossaryTitleTranslator({ call: llm.schemaCall, chaptersDir: CHAPTERS }),
    }),
  )
  .use(
    createChapterBodyTranslator({
      call: llm.schemaCall,
      chaptersDir: CHAPTERS,
      concurrency: translateConcurrency(),
    }),
  )
  .use(chapterPairsLinter)
  .use(createTranslateOutputs({ chaptersDir: CHAPTERS }))
  .to('@chapters')
