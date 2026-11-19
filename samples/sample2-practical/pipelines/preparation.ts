import { join } from 'node:path'
import { annotate, definePipeline, defineProcess, log, useCase } from '@mt/core'
import {
  type Glossary,
  type LlmRequest,
  chapterIndexer,
  createGlossaryExtractor,
  createSummaryTool,
  defineStatFreq,
  summarizeHeuristic,
} from '@mt/tools'
import '@mt/waypoint'
import { writeGlossaryIndexTool } from '../lib/glossary-index.js'
import { chapterOnly } from '../lib/input.js'
import { ROOT, pickFor } from '../lib/llm.js'
import { MOCK_NER_ANSWER, writeEntities } from '../lib/ner.js'
import { writeGlossary, writeSummaries } from '../lib/outputs.js'
import {
  type PreprocessPlan,
  SKIP_LOG,
  createEmitCleanChapter,
  createPreprocessChapterTool,
  createWritePreprocessReport,
  loadPreprocessGlossary,
  readPreprocessPlan,
} from '../lib/preprocess.js'
import {
  collectChapterQuality,
  qualityRootUri,
  qualitySourceUri,
  writeQuality,
} from '../lib/quality.js'
import { VOCAB_MAX_NGRAM, VOCAB_MIN_WORD_LEN, VOCAB_TOP_K, writeVocabulary } from '../lib/vocab.js'

/**
 * Per-chapter summary for context.
 *
 * The summary is not a deliverable by itself: `translate-chapters.ts` injects
 * `schema/chapter<N>.summary.md` into the prompt as context only. Run this pipe before the
 * body translation.
 *
 *   books/book2/chapter-*.en.md → createSummaryTool → chapters/schema/chapter<N>.summary.md
 *
 * Tool contract: `createSummaryTool` stores `summary` (first item) and, for a batched
 * envelope, `summaryByItem` (one value per input, see
 * `packages/tools/src/normalization/schema/extractor.ts:196-200`). The glue below reads
 * `summaryByItem` and falls back to `summary` for a single chapter; the old G1 defect was not
 * the variable name but the tool's silent `fallback: body`: a rejected LLM answer wrote the
 * whole chapter into the summary file. `writeSummaries` now guards that (R6).
 *
 * The mock backend returns an extractive paragraph summary of the prompt body; the default
 * prompt asks for a brief `- ` bullet list, which the tool joins into a paragraph. Either way
 * `writeSummaries` emits dash bullets. `MT_LLM_TOOL=ollama` (or `router`) runs the same pipe
 * against a real model.
 */
function summaryMockAnswer(req: LlmRequest): string {
  const user = [...req.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
  const heading = /^#\s+.+$/m.exec(user)
  const body = heading ? user.slice((heading.index ?? 0) + heading[0].length) : user
  return summarizeHeuristic(body, { sentences: 3 }).replace(/\s+/g, ' ').trim()
}

let summaryBackend: ReturnType<typeof pickFor> | undefined
function summaryPick() {
  summaryBackend ??= pickFor('summary', summaryMockAnswer)
  return summaryBackend
}

const summaryChild = definePipeline({ id: 'practical-summary-child' })
  .use(createSummaryTool({ call: (req, ctx) => summaryPick().schemaCall(req, ctx) }))
  .use(writeSummaries)
  .to('@chapters')

export const summary = definePipeline({ id: 'practical-summary' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .subflow('batch://?size=100', summaryChild)

/**
 * Stage 3 of the book flow: main entities of the whole book (no new `Tool`).
 *
 *   books/book2 chapters → batch://?size=100 → createGlossaryExtractor → writeEntities
 *                                          → chapters/schema/entities.json
 *                                          + chapters/schema/chapter<N>.entities.json
 *
 * One LLM pass over the corpus (`chunkMode:'auto'` is mandatory: the default `shrink` mode
 * truncates at `GLOSSARY_CORPUS_MAX_CHARS = 12_000`, and book2 is ~92 000 chars — 13 % of the
 * book would be seen). Projection back onto chapters is the tagger's `compileTermMatcher` /
 * `countTerms`, so it costs no requests. The batch subflow hands the child the whole corpus as
 * one package: counts, `firstChapter` and the chapter timeline are cross-chapter.
 */
let nerBackend: ReturnType<typeof pickFor> | undefined
function nerPick() {
  nerBackend ??= pickFor('ner', () => MOCK_NER_ANSWER)
  return nerBackend
}

const nerChild = definePipeline({ id: 'practical-ner-child' })
  .use(
    createGlossaryExtractor({
      call: (req, ctx) => nerPick().schemaCall(req, ctx),
      chunkMode: 'auto',
      minCount: 2,
      relations: { enabled: false },
      enrich: { enabled: false },
    }),
  )
  .use(writeEntities)
  .to('@schema')

export const ner = definePipeline({ id: 'practical-ner' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .subflow('batch://?size=100', nerChild)

/**
 * Stage 4 of the book flow: statistical 4/3/2/1-gram vocabulary (CPU only, 0 LLM calls).
 *
 *   books/book2 chapters → batch://?size=100 → defineStatFreq (book total) → writeVocabulary
 *                                          → chapters/schema/vocabulary.json
 *
 * The book-wide report ranks the candidates; `writeVocabulary` recounts every chapter with the
 * exported pure `buildStatFreqReport` for `chapters[]`/`df` and adds the capitalisation signal.
 * This pipe never imports `lib/llm.ts`: no `pickFor`, no model resolution, no backend.
 */
const vocabChild = definePipeline({ id: 'practical-vocabulary-child' })
  .use(
    defineStatFreq({
      maxNgram: VOCAB_MAX_NGRAM,
      minWordLen: VOCAB_MIN_WORD_LEN,
      topK: VOCAB_TOP_K,
    }),
  )
  .use(writeVocabulary)
  .to('@schema')

export const vocabulary = definePipeline({ id: 'practical-vocabulary' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .subflow('batch://?size=100', vocabChild)

/**
 * Glossary / term extraction over the whole book.
 *
 * The batch subflow (`batch://?size=100`) hands the child the whole corpus as one package, so
 * counts, `firstChapter` and relations are cross-chapter.
 * The heuristic pass seeds candidates; the picked LLM classifies the names it sees. The
 * resulting `chapters/glossary.json` is meant to be edited by hand (`ru`, `type`, `aliases`,
 * `ignored`) — re-running keeps those edits and only proposes new terms.
 */
const MOCK_GLOSSARY = JSON.stringify([
  {
    name: 'Nadia Okonkwo',
    category: 'character',
    description: 'An audio archivist searching for her missing brother.',
    references: ['Emeka Okonkwo'],
  },
  {
    name: 'Emeka Okonkwo',
    category: 'character',
    description: 'Nadia’s brother, missing since the Pelargic sank.',
    references: ['Nadia Okonkwo'],
  },
  {
    name: 'Marrow Bay',
    category: 'place',
    description: 'The coastal town where the archive sits.',
    references: [],
  },
])

let glossaryBackend: ReturnType<typeof pickFor> | undefined
function glossaryPick() {
  glossaryBackend ??= pickFor('glossary', () => MOCK_GLOSSARY)
  return glossaryBackend
}

const glossaryChild = definePipeline({ id: 'practical-glossary-child' })
  .use(
    createGlossaryExtractor({
      call: (req, ctx) => glossaryPick().schemaCall(req, ctx),
      minCount: 2,
      relations: { enabled: false },
      enrich: { enabled: false },
    }),
  )
  .use(writeGlossary)
  .to('@chapters')

export const glossary = definePipeline({ id: 'practical-glossary' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .subflow('batch://?size=100', glossaryChild)

/**
 * Stage between `glossary` and the quality gate: the book-wide glossary projected onto the
 * chapters it actually occurs in (CPU only, 0 LLM calls).
 *
 *   chapters/en + chapters/glossary.json → write-glossary-index → chapters/glossary-index.json
 *
 * A missing `glossary.json` is not an error (the chain may run before the first extraction):
 * the step logs `index: no glossary` and writes nothing. `translate-chapters` reads the index to
 * render the "terms so far" prompt block.
 */
const glossaryIndexChapters = join(ROOT, 'chapters')

const indexChild = definePipeline({ id: 'practical-glossary-index-child' })
  .use(writeGlossaryIndexTool(glossaryIndexChapters))
  .to('void://')

export const glossaryIndex = definePipeline({ id: 'practical-glossary-index' })
  .from('md://./chapters/en')
  .subflow('batch://?size=1000', indexChild)

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
const qualityMeasureChild = definePipeline({ id: 'practical-quality-child' })
  .from('batch://members')
  .use(chapterIndexer)
  .use(collectChapterQuality)
  .to('batch://return')

const qualityAggregateChild = definePipeline({ id: 'practical-quality-aggregate' })
  .use(writeQuality)
  .to('batch://return')

export const quality = annotate(
  definePipeline({ id: 'practical-quality' })
    .from(qualitySourceUri())
    .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
    .subflow('batch://?size=100', qualityMeasureChild)
    .subflow('batch://?size=100', qualityAggregateChild)
    .to(qualityRootUri()),
  useCase('UC057', { name: 'Collect chapter quality warnings' }),
)

/**
 * Stage 2b of the book flow: preprocess branch B.
 *
 *   source (split dir when produced, else books/book2) chapters
 *     → index → merged typo/proofread/gender pass (failed chapters only; all when forced)
 *     → chapters/clean/chapter<N>.md for every chapter
 *     → chapters/schema/preprocess-report.json
 *
 * The quality verdict is read lazily at run time, not at module load: this stage now lives in
 * the same `preparation` process as the quality gate that writes it. A `translate` verdict
 * without `MT_FORCE_BRANCH=preprocess` is a no-op: one `preprocess skipped verdict=translate`
 * line, no chapter batch, no output file and no backend resolution.
 */
let preprocessCachedPlan: PreprocessPlan | undefined
function preprocessPlan(): PreprocessPlan {
  preprocessCachedPlan ??= readPreprocessPlan()
  return preprocessCachedPlan
}

const preprocessCache: { glossary?: Glossary } = {}

function preprocessMockAnswer(req: LlmRequest): string {
  return [...req.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
}

const preprocessChapterChild = definePipeline({ id: 'practical-preprocess-chapter' })
  .from('batch://members')
  .use(chapterIndexer)
  .use(
    createPreprocessChapterTool({
      plan: preprocessPlan,
      llm: () => {
        const preprocessLlm = pickFor('preprocess', preprocessMockAnswer)
        return { call: preprocessLlm.schemaCall, model: preprocessLlm.model }
      },
      glossary: () => {
        preprocessCache.glossary ??= loadPreprocessGlossary()
        return preprocessCache.glossary
      },
    }),
  )
  .to('batch://return')

const preprocessReportChild = definePipeline({ id: 'practical-preprocess-report' })
  .use(createWritePreprocessReport(preprocessPlan))
  .to('batch://return')

let preprocessSkipLogged = false

export const preprocess = annotate(
  definePipeline({ id: 'practical-preprocess' })
    .from(qualitySourceUri())
    .flatMap(async (markdown: unknown) => {
      if (preprocessPlan().skip) {
        if (!preprocessSkipLogged) {
          preprocessSkipLogged = true
          log.info(SKIP_LOG)
        }
        return []
      }
      return chapterOnly(markdown) ? [String(markdown)] : []
    })
    .subflow('batch://?size=100', preprocessChapterChild)
    .subflow('batch://?size=100', preprocessReportChild)
    .use(createEmitCleanChapter())
    .to(qualityRootUri()),
  useCase('UC058', { name: 'Auto-fix chapter text issues' }),
)

/**
 * Phase 2 — preparation.
 *
 * Build every artefact the translation prompts need and pick the source branch: summaries,
 * entities, vocabulary, glossary, the per-chapter glossary index, the quality verdict, and the
 * conditional preprocess/clean branch.
 *
 *   summary → NER → vocabulary → glossary → glossary-index → quality → preprocess
 *
 * `quality` runs after `glossary` because the gate uses the glossary as a proper-noun
 * allowlist. `preprocess` runs last and reads the verdict lazily, so the no-op `translate`
 * branch costs no LLM call and writes no file.
 */

export default defineProcess(
  [summary, ner, vocabulary, glossary, glossaryIndex, quality, preprocess],
  { id: 'practical-preparation' },
)
