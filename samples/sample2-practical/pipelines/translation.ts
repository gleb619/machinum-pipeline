import { join } from 'node:path'
import { annotate, definePipeline, defineProcess, useCase, withItem } from '@mt/core'
import {
  GLOSSARY_INDEX_FILE,
  bookCompiler,
  chapterPairsLinter,
  chaptersToTitleInputs,
  createBatchTitleTranslator,
  createChapterBodyTranslator,
  createGlossaryTitleTranslator,
  createTitleTranslator,
  createTranslateOutputs,
  priorTermsEnabled,
  readGlossaryIndex,
  renderPriorTerms,
  sortChapters,
  tagWithGlossary,
  translateBlockLines,
  translateConcurrency,
  writeTitles,
} from '@mt/tools'
import '@mt/waypoint'
import { CHAPTERS_DIR, defineChapterPipeline } from '../lib/config.js'
import { bookSource } from '../lib/input.js'
import { installSampleMock } from '../lib/mock-llm.js'

/**
 * Phase 3 — translation: titles → bodies → one assembled book. Backends are process-level
 * (`.install(mockLlm(...))` in `lib/mock-llm.ts`); nothing here knows about mocks.
 */

function positiveInt(raw: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback
}

/** Consecutive body lines per request; titles stay per-chapter. */
const blockLines = translateBlockLines()
const maxTokens = positiveInt(
  process.env.MT_TRANSLATE_MAX_TOKENS,
  blockLines > 1 ? 8192 : 2048,
  8192,
)

/** "Terms so far" context: empty without a glossary index or when `MT_PRIOR_TERMS=0`. */
const priorIndex = priorTermsEnabled()
  ? readGlossaryIndex(join(CHAPTERS_DIR, GLOSSARY_INDEX_FILE))
  : undefined
const priorTerms = (chapter: number): string =>
  priorIndex === undefined ? '' : renderPriorTerms(priorIndex, chapter)

/** Titles: chapter bodies → glossary-aware batches of five → `chapters/titles.json`. */
const titlesChild = definePipeline({ id: 'practical-translate-titles-child' })
  .use(chaptersToTitleInputs)
  .use(
    createTitleTranslator({
      translate: createGlossaryTitleTranslator({ chaptersDir: CHAPTERS_DIR }),
    }),
  )
  .use(writeTitles)
  .to('@chapters')

export const translateTitles = defineChapterPipeline('practical-translate-titles').subflow(
  'batch://?size=5',
  titlesChild,
)

/** Bodies: tag terms, translate titles, translate blocks, lint parity, write `chapters/ru/`. */
const bodyTranslator = annotate(
  createChapterBodyTranslator({
    chaptersDir: CHAPTERS_DIR,
    concurrency: translateConcurrency(),
    blockLines,
    maxTokens,
    priorTerms,
  }),
  useCase('UC012', { name: 'Process items in parallel' }),
)

const chaptersChild = annotate(
  definePipeline({ id: 'practical-translate-chapters-child' })
    .use(tagWithGlossary(CHAPTERS_DIR))
    .use(chaptersToTitleInputs)
    .use(createBatchTitleTranslator({ chaptersDir: CHAPTERS_DIR }))
    .use(bodyTranslator)
    .use(chapterPairsLinter)
    .use(createTranslateOutputs({ chaptersDir: CHAPTERS_DIR }))
    .to('@chapters'),
  useCase('UC060', { name: 'Translate chapter paragraph-by-paragraph' }),
)

export const translateChapters = annotate(
  defineChapterPipeline('practical-translate-chapters', bookSource()).subflow(
    'batch://?size=5',
    chaptersChild,
  ),
  useCase('UC013', { name: 'Batch items (Item[])' }),
)

/** Assemble: numeric chapter order + frontmatter/TOC → `chapters/book/book.md`. */
const assembleChild = definePipeline({ id: 'practical-assemble-child' })
  .use(sortChapters)
  .use(bookCompiler, (env) =>
    withItem(env, { title: 'The Quiet Frequency — Russian draft', chapters: env.item }),
  )
  .to('book://./chapters/book')

export const assemble = defineChapterPipeline('practical-assemble', '@ru').subflow(
  'batch://?size=1000',
  assembleChild,
)

export default defineProcess([translateTitles, translateChapters, assemble], {
  id: 'practical-translation',
}).install(installSampleMock())
