import { definePipeline } from '@mt/core'
import { createSummaryTool } from '@mt/tools'
import '@mt/waypoint'
import { chapterOnly } from '../lib/input.js'
import { pickFor } from '../lib/llm.js'
import { writeSummaries } from '../lib/outputs.js'

/**
 * Per-chapter summary for context.
 *
 * The summary is not a deliverable by itself: `translate-chapters.ts` injects
 * `schema/chapter<N>.summary.md` into the prompt as context only. Run this pipe before the
 * body translation.
 *
 *   books/book2/chapter-*.en.md → createSummaryTool → chapters/schema/chapter<N>.summary.md
 *
 * The mock backend returns a fixed sentence offline; `MT_LLM_TOOL=ollama` (or `router`) runs
 * the same pipe against a real model.
 */
const llm = pickFor(
  'summary',
  () => 'Mock summary: Nadia Okonkwo follows a recovered tape into a coastal cover-up.',
)

export default definePipeline({ id: 'practical-summary' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .batch(100)
  .use(createSummaryTool({ model: llm.model, call: llm.schemaCall }))
  .use(writeSummaries)
  .to('@chapters')
