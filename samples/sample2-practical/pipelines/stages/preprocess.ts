import { annotate, definePipeline, log, useCase } from '@mt/core'
import { type Glossary, type LlmRequest, chapterIndexer } from '@mt/tools'
import '@mt/waypoint'
import { chapterOnly } from '../../lib/input.js'
import { pickFor } from '../../lib/llm.js'
import {
  type PreprocessPlan,
  SKIP_LOG,
  createEmitCleanChapter,
  createPreprocessChapterTool,
  createWritePreprocessReport,
  loadPreprocessGlossary,
  readPreprocessPlan,
} from '../../lib/preprocess.js'
import { qualityRootUri, qualitySourceUri } from '../../lib/quality.js'

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
let cachedPlan: PreprocessPlan | undefined
function plan(): PreprocessPlan {
  cachedPlan ??= readPreprocessPlan()
  return cachedPlan
}

const cache: { glossary?: Glossary } = {}

function mockAnswer(req: LlmRequest): string {
  return [...req.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
}

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

let skipLogged = false

export default annotate(
  definePipeline({ id: 'practical-preprocess' })
    .from(qualitySourceUri())
    .flatMap(async (markdown: unknown) => {
      if (plan().skip) {
        if (!skipLogged) {
          skipLogged = true
          log.info(SKIP_LOG)
        }
        return []
      }
      return chapterOnly(markdown) ? [String(markdown)] : []
    })
    .subflow('batch://?size=100', chapterChild)
    .subflow('batch://?size=100', reportChild)
    .use(createEmitCleanChapter())
    .to(qualityRootUri()),
  useCase('UC058', { name: 'Auto-fix chapter text issues' }),
)
