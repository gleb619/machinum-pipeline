import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { definePipeline } from '@mt/core'
import type { LlmRequest } from '@mt/tools'
import {
  chapterPairsLinter,
  chaptersToTitleInputs,
  createChapterBodyTranslator,
  createTranslateOutputs,
  translateConcurrency,
} from '@mt/tools'
import '@mt/waypoint'
import { bookSource, chapterOnly } from '../lib/input.js'
import { ROOT, pickFor } from '../lib/llm.js'
import { tagWithGlossary } from '../lib/outputs.js'
import { createBatchTitleTranslator } from '../lib/titles.js'

/**
 * Translate the whole book body with parity linting.
 *
 *   books/book2 → batch of 5 → tag glossary terms → titles → block body translation
 *               → chapterPairsLinter → chapters/ru/chapter<N>.md + chapters/titles.json
 *
 * `tagWithGlossary` makes the terms of `chapters/glossary.json` visible to the prompt builder;
 * `createChapterBodyTranslator` also reads `chapters/schema/chapter<N>.summary.md` as context.
 * Body lines go in blocks of `MT_TRANSLATE_BLOCK_LINES` (default 40) per `xml` request; a failed
 * block is retried once, then only its failing lines are re-requested one by one. Passed lines
 * are memoised. Run `summary.ts` and `glossary.ts` first to give the prompts real context.
 *
 * `MT_TRANSLATE_MAX_TOKENS` (default 8192 in block mode, 2048 per line; max 8192) is the
 * per-request output budget — a thinking model truncates a block to an empty `content` below it. `MT_ONLY_CHAPTERS=1,2` narrows the run; `MT_TRANSLATE_PROMPT_LOG=<file>`
 * records every prompt with the mock backend (the tests assert on that log). The default backend
 * is the offline mock.
 */
const CHAPTERS = join(ROOT, 'chapters')

function positiveInt(raw: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback
}

/** Consecutive body lines per request; a chapter shorter than this is one single block. */
const BLOCK_LINES = positiveInt(process.env.MT_TRANSLATE_BLOCK_LINES, 40)
/**
 * Thinking models need headroom or they return `finishReason:'length'` on a block, and a block
 * request carries `BLOCK_LINES` translations plus an open-ended reasoning trace: the free
 * particle-1 model answers 2048-token *block* requests with an empty `content`. Per-line
 * requests keep the old default.
 */
const MAX_TOKENS = positiveInt(
  process.env.MT_TRANSLATE_MAX_TOKENS,
  BLOCK_LINES > 1 ? 8192 : 2048,
  8192,
)

let mockCalls = 0
function mockAnswer(req: LlmRequest): string {
  const system = req.messages.find((message) => message.role === 'system')?.content ?? ''
  const user = [...req.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
  const log = process.env.MT_TRANSLATE_PROMPT_LOG
  if (log) appendFileSync(log, `${JSON.stringify({ system, user })}\n`)
  mockCalls += 1
  // Fail both attempts of the first body block, so the per-line fallback has to take over.
  if (process.env.MT_MOCK_FLAKY === '1' && (mockCalls === 2 || mockCalls === 3)) return ''
  // Block requests carry the lines as <result><id>N</id><origin>…</origin></result>: mirror the
  // xml output contract instead of echoing the wrapper (which would parse as zero lines).
  const blocks = [
    ...user.matchAll(/<result><id>(\d+)<\/id><origin>([\s\S]*?)<\/origin><\/result>/g),
  ]
  if (blocks.length > 0) {
    return blocks
      .map((m) => `<result><id>${m[1]}</id><translated>${ruMock(m[2] ?? '')}</translated></result>`)
      .join('\n')
  }
  return ruMock(user)
}

function ruMock(text: string): string {
  return text.replace(/[A-Za-z]+/g, 'слово')
}

const llm = pickFor('translate', mockAnswer)

const translateChild = definePipeline({ id: 'practical-translate-chapters-child' })
  .use(tagWithGlossary(CHAPTERS))
  .use(chaptersToTitleInputs)
  .use(createBatchTitleTranslator({ call: llm.schemaCall, chaptersDir: CHAPTERS }))
  .use(
    createChapterBodyTranslator({
      call: llm.schemaCall,
      chaptersDir: CHAPTERS,
      concurrency: translateConcurrency(),
      blockLines: BLOCK_LINES,
      maxTokens: MAX_TOKENS,
    }),
  )
  .use(chapterPairsLinter)
  .use(createTranslateOutputs({ chaptersDir: CHAPTERS }))
  .to('@chapters')

export default definePipeline({ id: 'practical-translate-chapters' })
  .from(bookSource())
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .subflow('batch://?size=5', translateChild)
