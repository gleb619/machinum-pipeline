import { definePipeline, defineTool } from '@mt/core'
import { type Glossary, type LlmRequest, chapterIndexer } from '@mt/tools'
import '@mt/waypoint'
import { chapterOnly } from '../lib/input.js'
import { pickFor } from '../lib/llm.js'
import {
  SKIP_LOG,
  createEmitCleanChapter,
  createPreprocessChapterTool,
  createWritePreprocessReport,
  loadPreprocessGlossary,
  readPreprocessPlan,
} from '../lib/preprocess.js'
import { qualityRootUri, qualitySourceUri } from '../lib/quality.js'

/**
 * Stage 6b of the book flow: preprocess branch B.
 *
 *   source (split dir when produced, else books/book2) chapters
 *     → index → merged typo/proofread/gender pass (failed chapters only; all when forced)
 *     → chapters/clean/chapter<N>.md for every chapter
 *     → chapters/schema/preprocess-report.json
 *
 * A `translate` verdict without `MT_FORCE_BRANCH=preprocess` is a no-op: one item goes to the
 * `void://` target so the stage logs `preprocess skipped verdict=translate` once, no chapter is
 * read into the pipeline and no backend is resolved. `MT_FORCE_BRANCH` keeps working for tests
 * and lets a clean book exercise the full branch.
 */
const plan = readPreprocessPlan()

const cache: { glossary?: Glossary } = {}

function mockAnswer(req: LlmRequest): string {
  return [...req.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
}

function processPipeline() {
  const chapterChild = definePipeline({ id: 'practical-preprocess-chapter' })
    .from('batch://members')
    .use(chapterIndexer)
    .use(
      createPreprocessChapterTool({
        plan,
        llm: () => {
          const llm = pickFor('preprocess', mockAnswer)
          return { call: llm.schemaCall, model: llm.model }
        },
        glossary: () => {
          cache.glossary ??= loadPreprocessGlossary()
          return cache.glossary
        },
      }),
    )
    .to('batch://return')

  const reportChild = definePipeline({ id: 'practical-preprocess-report' })
    .use(createWritePreprocessReport(plan))
    .to('batch://return')

  return definePipeline({ id: 'practical-preprocess' })
    .from(qualitySourceUri())
    .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
    .subflow('batch://?size=100', chapterChild)
    .subflow('batch://?size=100', reportChild)
    .use(createEmitCleanChapter())
    .to(qualityRootUri())
}

function skipPipeline() {
  let emitted = false
  const notice = defineTool<string, string>({
    name: 'preprocess-skip-notice',
    version: '1.0.0',
    mdDescription: 'Logs the no-op preprocess verdict once and passes the item through.',
    async invoke(env, ctx) {
      ctx.run.logger.info(SKIP_LOG)
      return env
    },
  })

  return definePipeline({ id: 'practical-preprocess' })
    .from(qualitySourceUri())
    .flatMap(async (markdown: unknown) => {
      if (emitted) return []
      emitted = true
      return [String(markdown)]
    })
    .use(notice)
    .to('void://')
}

export default plan.skip ? skipPipeline() : processPipeline()
