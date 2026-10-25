import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { definePipeline } from '@mt/core'
import {
  type LlmRequest,
  chapterNumberOf,
  chapterPairsLinter,
  chaptersToTitleInputs,
  createChapterBodyTranslator,
  createGlossaryTitleTranslator,
  createTitleTranslator,
  createTranslateOutputs,
  onlyChapters,
  pickLlmTool,
} from '@mt/tools'
import '@mt/waypoint'

// === Translate stage: chapters/en-tagged/*.md -> chapters/ru/*.md (+ chapters/titles.json) ===
// 1. Titles: `titleTranslator` over batches of 5 chapters, glossary-aware -> chapters/titles.json.
// 2. Body: every non-empty line is translated on its own, SLOWLY (MT_TRANSLATE_CONCURRENCY,
//    default 1). The prompt carries the chapter summary (context only) and ONLY the glossary
//    entries whose <term id> occurs in that line.
// 3. Each line is linted on its own; a bad reply throws a retryable LineParityError, so the
//    engine retries (lines that already passed are memoised and not re-sent). The whole chapter
//    goes through `lineParityLinter` before it is written.
//
// Env: MT_LLM_TOOL / MT_LLM_MODEL (`pickLlmTool`; default offline mock), MT_TRANSLATE_CONCURRENCY,
// MT_ONLY_CHAPTERS (e.g. "1,3"), MT_TRANSLATE_PROMPT_LOG (mock only: jsonl of prompts).

const ROOT = resolve(import.meta.dirname, '..')
const CHAPTERS = join(ROOT, 'chapters')

/** Offline mock: words become "слово", `[brackets]` and punctuation stay. Logs prompts on demand. */
let mockCalls = 0
function mockAnswer(req: LlmRequest): string {
  const system = req.messages.find((m) => m.role === 'system')?.content ?? ''
  const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const log = process.env.MT_TRANSLATE_PROMPT_LOG
  if (log) appendFileSync(log, `${JSON.stringify({ system, user })}\n`)
  mockCalls++
  // MT_MOCK_FLAKY=1: the first body-line answer is empty -> the line check must reject it.
  if (process.env.MT_MOCK_FLAKY === '1' && mockCalls === 3) return ''
  return user.replace(/[A-Za-z]+/g, 'слово')
}

const llm = pickLlmTool({ configPath: join(ROOT, 'mt.json'), mockSource: mockAnswer })

const only = onlyChapters()

const translateFlow = definePipeline()
  .from('md://./chapters/en-tagged')
  .flatMap(async (md: string) => (only && !only.has(chapterNumberOf(md, 0)) ? [] : [md]))
  .batch(5)
  .use(chaptersToTitleInputs)
  .use(
    createTitleTranslator({
      translate: createGlossaryTitleTranslator({ call: llm.schemaCall, chaptersDir: CHAPTERS }),
    }) as never,
  )
  .use(createChapterBodyTranslator({ call: llm.schemaCall, chaptersDir: CHAPTERS }))
  .use(chapterPairsLinter)
  .use(createTranslateOutputs({ chaptersDir: CHAPTERS }))
  .to('@chapters')

export { translateFlow }
export default translateFlow
