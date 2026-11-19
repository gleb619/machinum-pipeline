import { annotate, definePipeline, defineProcess, log, useCase } from '@mt/core'
import {
  chapterIndexer,
  createGlossaryExtractor,
  createSummaryTool,
  defineStatFreq,
} from '@mt/tools'
import '@mt/waypoint'
import {
  type PreprocessPlan,
  VOCAB_MAX_NGRAM,
  VOCAB_MIN_WORD_LEN,
  VOCAB_TOP_K,
  collectProperNouns,
  createCollectChapterQuality,
  createEmitCleanChapter,
  createGlossaryIndexTool,
  createPreprocessChapterTool,
  createWritePreprocessReport,
  createWriteQualityTool,
  writeEntities,
  writeGlossary,
  writeSummaries,
  writeVocabulary,
} from '@mt/tools'
import {
  chapterDocs,
  chaptersDirOf,
  defineChapterPipeline,
  properNounSources,
  qualityRootUri,
  qualitySourceUri,
  readRatioToMean,
} from '../lib/config.js'
import { installSampleMock } from '../lib/mock-llm.js'
import { SKIP_LOG, readPreprocessPlan } from '../lib/preprocess.js'

/**
 * Phase 2 — preparation: every artefact the translator needs, derived from the EN book.
 * No backend is passed here: each LLM tool resolves the process backend at run time and the
 * process-level mock (or the picked real model) supplies the answers.
 */

const BATCH = 'batch://?size=100'

/** Per-chapter summary: `chapters/schema/chapter<N>.summary.md`. */
const summaryChild = definePipeline({ id: 'practical-summary-child' })
  .use(createSummaryTool())
  .use(writeSummaries)
  .to('@chapters')

export const summary = defineChapterPipeline('practical-summary').subflow(BATCH, summaryChild)

/** Book-wide entities in one auto-chunked pass: `schema/entities.json` + per-chapter files. */
const nerChild = definePipeline({ id: 'practical-ner-child' })
  .use(
    createGlossaryExtractor({
      chunkMode: 'auto',
      minCount: 2,
      relations: { enabled: false },
      enrich: { enabled: false },
    }),
  )
  .use(writeEntities)
  .to('@schema')

export const ner = defineChapterPipeline('practical-ner').subflow(BATCH, nerChild)

/** CPU-only 4/3/2/1-gram vocabulary: `schema/vocabulary.json`. */
const vocabularyChild = definePipeline({ id: 'practical-vocabulary-child' })
  .use(
    defineStatFreq({
      maxNgram: VOCAB_MAX_NGRAM,
      minWordLen: VOCAB_MIN_WORD_LEN,
      topK: VOCAB_TOP_K,
    }),
  )
  .use(writeVocabulary)
  .to('@schema')

export const vocabulary = defineChapterPipeline('practical-vocabulary').subflow(
  BATCH,
  vocabularyChild,
)

/** Book-wide glossary with cross-chapter counts; hand edits in `glossary.json` survive a rerun. */
const glossaryChild = definePipeline({ id: 'practical-glossary-child' })
  .use(
    createGlossaryExtractor({
      minCount: 2,
      relations: { enabled: false },
      enrich: { enabled: false },
    }),
  )
  .use(writeGlossary)
  .to('@chapters')

export const glossary = defineChapterPipeline('practical-glossary').subflow(BATCH, glossaryChild)

/** CPU-only: project `glossary.json` onto the chapters where each term occurs. */
const glossaryIndexChild = definePipeline({ id: 'practical-glossary-index-child' })
  .use(createGlossaryIndexTool({ chaptersDir: chaptersDirOf() }))
  .to('@chapters')

export const glossaryIndex = defineChapterPipeline(
  'practical-glossary-index',
  'md://./chapters/en',
).subflow('batch://?size=1000', glossaryIndexChild)

/** Quality gate (CPU only): per-chapter signals aggregated into `schema/quality.json`. */
let qualityNamesCache: ReadonlySet<string> | undefined
function qualityNames(): ReadonlySet<string> {
  qualityNamesCache ??= collectProperNouns(properNounSources())
  return qualityNamesCache
}

const collectChapterQuality = createCollectChapterQuality({ names: qualityNames })
const writeQuality = createWriteQualityTool({
  source: () => qualitySourceUri(),
  ratioToMean: () => readRatioToMean(),
})

const qualityChild = definePipeline({ id: 'practical-quality-child' })
  .from('batch://members')
  .use(chapterIndexer)
  .use(collectChapterQuality)
  .to('batch://return')

const qualityAggregateChild = definePipeline({ id: 'practical-quality-aggregate' })
  .use(writeQuality)
  .to('batch://return')

export const quality = annotate(
  defineChapterPipeline('practical-quality', qualitySourceUri())
    .subflow(BATCH, qualityChild)
    .subflow(BATCH, qualityAggregateChild)
    .to(qualityRootUri()),
  useCase('UC057', { name: 'Collect chapter quality warnings' }),
)

/**
 * Preprocess (LLM, failed chapters only): clean text → `chapters/clean/` plus
 * `schema/preprocess-report.json`. A `translate` verdict is a lazy no-op (no model call).
 */
let preprocessPlanCache: PreprocessPlan | undefined
function preprocessPlan(): PreprocessPlan {
  preprocessPlanCache ??= readPreprocessPlan()
  return preprocessPlanCache
}

let preprocessSkipLogged = false
function preprocessDocs(markdown: unknown): string[] {
  if (!preprocessPlan().skip) return chapterDocs(markdown)
  if (!preprocessSkipLogged) {
    preprocessSkipLogged = true
    log.info(SKIP_LOG)
  }
  return []
}

const preprocessChapterChild = definePipeline({ id: 'practical-preprocess-chapter' })
  .from('batch://members')
  .use(chapterIndexer)
  .use(createPreprocessChapterTool({ plan: preprocessPlan }))
  .to('batch://return')

const preprocessReportChild = definePipeline({ id: 'practical-preprocess-report' })
  .use(createWritePreprocessReport(preprocessPlan))
  .to('batch://return')

export const preprocess = annotate(
  definePipeline({ id: 'practical-preprocess' })
    .from(qualitySourceUri())
    .flatMap(async (markdown) => preprocessDocs(markdown))
    .subflow(BATCH, preprocessChapterChild)
    .subflow(BATCH, preprocessReportChild)
    .use(createEmitCleanChapter())
    .to(qualityRootUri()),
  useCase('UC058', { name: 'Auto-fix chapter text issues' }),
)

/** summary → NER → vocabulary → glossary → glossary-index → quality → preprocess. */
export default defineProcess(
  [summary, ner, vocabulary, glossary, glossaryIndex, quality, preprocess],
  {
    id: 'practical-preparation',
  },
).install(installSampleMock())
