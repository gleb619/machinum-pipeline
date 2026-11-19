import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { annotate, definePipeline, defineProcess, useCase } from '@mt/core'
import type { LlmRequest } from '@mt/tools'
import {
  bookCompiler,
  chapterPairsLinter,
  chaptersToTitleInputs,
  createChapterBodyTranslator,
  createGlossaryTitleTranslator,
  createTitleTranslator,
  createTranslateOutputs,
  translateConcurrency,
} from '@mt/tools'
import '@mt/waypoint'
import {
  GLOSSARY_INDEX_FILE,
  priorTermsEnabled,
  readGlossaryIndex,
  renderPriorTerms,
} from '../lib/glossary-index.js'
import { bookSource, chapterOnly } from '../lib/input.js'
import { ROOT, pickFor } from '../lib/llm.js'
import { sortChapters, tagWithGlossary, withBookTitle, writeTitles } from '../lib/outputs.js'
import { createBatchTitleTranslator } from '../lib/titles.js'

/**
 * Translate the chapter titles in batches of five.
 *
 *   books/book2 → filter chapters → batch of 5 → title translator → chapters/titles.json
 *
 * `chapters/titles.json` is merged chapter-by-chapter, so a partial re-run (`MT_ONLY_CHAPTERS`)
 * never drops the titles of the other chapters.
 */
const titlesChapterDir = join(ROOT, 'chapters')

let titlesBackend: ReturnType<typeof pickFor> | undefined
function titlesPick() {
  titlesBackend ??= pickFor('titles', (req: LlmRequest) =>
    (req.messages.at(-1)?.content ?? '').replace(/[A-Za-z]+/g, 'слово'),
  )
  return titlesBackend
}

const titlesChild = definePipeline({ id: 'practical-translate-titles-child' })
  .use(chaptersToTitleInputs)
  .use(
    createTitleTranslator({
      translate: createGlossaryTitleTranslator({
        call: (req, ctx) => titlesPick().schemaCall(req, ctx),
        chaptersDir: titlesChapterDir,
      }),
    }),
  )
  .use(writeTitles)
  .to('@chapters')

export const translateTitles = definePipeline({ id: 'practical-translate-titles' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .subflow('batch://?size=5', titlesChild)

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
const chaptersChapterDir = join(ROOT, 'chapters')

/**
 * "Terms so far" block for chapter N from `chapters/glossary-index.json` (absent index = no
 * block; `MT_PRIOR_TERMS=0` disables it). Chapter 1 has no prior terms.
 */
const chaptersPriorIndex = priorTermsEnabled()
  ? readGlossaryIndex(join(chaptersChapterDir, GLOSSARY_INDEX_FILE))
  : undefined
const chaptersPriorTerms = (chapter: number): string =>
  chaptersPriorIndex === undefined ? '' : renderPriorTerms(chaptersPriorIndex, chapter)

function chaptersPositiveInt(
  raw: string | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback
}

/** Consecutive body lines per request; a chapter shorter than this is one single block. */
const chaptersBlockLines = chaptersPositiveInt(process.env.MT_TRANSLATE_BLOCK_LINES, 40)
/**
 * Thinking models need headroom or they return `finishReason:'length'` on a block, and a block
 * request carries `BLOCK_LINES` translations plus an open-ended reasoning trace: the free
 * particle-1 model answers 2048-token *block* requests with an empty `content`. Per-line
 * requests keep the old default.
 */
const chaptersMaxTokens = chaptersPositiveInt(
  process.env.MT_TRANSLATE_MAX_TOKENS,
  chaptersBlockLines > 1 ? 8192 : 2048,
  8192,
)

let chaptersMockCalls = 0
function chaptersMockAnswer(req: LlmRequest): string {
  const system = req.messages.find((message) => message.role === 'system')?.content ?? ''
  const user = [...req.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
  const log = process.env.MT_TRANSLATE_PROMPT_LOG
  if (log) appendFileSync(log, `${JSON.stringify({ system, user })}\n`)
  chaptersMockCalls += 1
  // Fail both attempts of the first body block, so the per-line fallback has to take over.
  if (process.env.MT_MOCK_FLAKY === '1' && (chaptersMockCalls === 2 || chaptersMockCalls === 3)) {
    return ''
  }
  // Block requests carry the lines as <result><id>N</id><origin>…</origin></result>: mirror the
  // xml output contract instead of echoing the wrapper (which would parse as zero lines).
  const blocks = [
    ...user.matchAll(/<result><id>(\d+)<\/id><origin>([\s\S]*?)<\/origin><\/result>/g),
  ]
  if (blocks.length > 0) {
    return blocks
      .map(
        (m) =>
          `<result><id>${m[1]}</id><translated>${chaptersRuMock(m[2] ?? '')}</translated></result>`,
      )
      .join('\n')
  }
  return chaptersRuMock(user)
}

function chaptersRuMock(text: string): string {
  return text.replace(/[A-Za-z]+/g, 'слово')
}

let chaptersBackend: ReturnType<typeof pickFor> | undefined
function chaptersPick() {
  chaptersBackend ??= pickFor('translate', chaptersMockAnswer)
  return chaptersBackend
}

const chaptersBodyTranslator = createChapterBodyTranslator({
  call: (req, ctx) => chaptersPick().schemaCall(req, ctx),
  chaptersDir: chaptersChapterDir,
  concurrency: translateConcurrency(),
  blockLines: chaptersBlockLines,
  maxTokens: chaptersMaxTokens,
  priorTerms: chaptersPriorTerms,
})
annotate(chaptersBodyTranslator, useCase('UC012', { name: 'Process items in parallel' }))

const chaptersChild = definePipeline({ id: 'practical-translate-chapters-child' })
  .use(tagWithGlossary(chaptersChapterDir))
  .use(chaptersToTitleInputs)
  .use(
    createBatchTitleTranslator({
      call: (req, ctx) => chaptersPick().schemaCall(req, ctx),
      chaptersDir: chaptersChapterDir,
    }),
  )
  .use(chaptersBodyTranslator)
  .use(chapterPairsLinter)
  .use(createTranslateOutputs({ chaptersDir: chaptersChapterDir }))
  .to('@chapters')
annotate(chaptersChild, useCase('UC060', { name: 'Translate chapter paragraph-by-paragraph' }))

export const translateChapters = annotate(
  definePipeline({ id: 'practical-translate-chapters' })
    .from(bookSource())
    .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
    .subflow('batch://?size=5', chaptersChild),
  useCase('UC013', { name: 'Batch items (Item[])' }),
)

/**
 * Assemble the translated book with `bookCompiler` → `book://`.
 *
 *   chapters/ru → batch of 1000 → sort by chapter number → bookCompiler → chapters/book/
 *
 * `book://` writes `book.md` (frontmatter, table of contents, chapters) and `book.json`
 * (TOC + completeness warnings: gaps, duplicates, ordering, empty bodies). The md source
 * discovers files in name order (`chapter1`, `chapter10`, ...), hence `sortChapters`.
 */
const assembleChild = definePipeline({ id: 'practical-assemble-child' })
  .use(sortChapters)
  .use(withBookTitle('The Quiet Frequency — Russian draft'))
  .use(bookCompiler)
  .to('book://./chapters/book')

export const assemble = definePipeline({ id: 'practical-assemble' })
  .from('@ru')
  .subflow('batch://?size=1000', assembleChild)

/**
 * Phase 3 — translation.
 *
 * Translate the titles and the body, then assemble the result into one book. `translate-titles`
 * keeps `chapters/titles.json` mergeable for partial runs; `translate-chapters` uses it plus the
 * prepared summary/glossary context; `assemble` sorts numerically and writes `book://`.
 *
 *   translate-titles → translate-chapters → assemble
 */
export default defineProcess([translateTitles, translateChapters, assemble], {
  id: 'practical-translation',
})
