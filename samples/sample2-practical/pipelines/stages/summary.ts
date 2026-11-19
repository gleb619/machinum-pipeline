import { definePipeline } from '@mt/core'
import type { LlmRequest } from '@mt/tools'
import { createSummaryTool, summarizeHeuristic } from '@mt/tools'
import '@mt/waypoint'
import { chapterOnly } from '../../lib/input.js'
import { pickFor } from '../../lib/llm.js'
import { writeSummaries } from '../../lib/outputs.js'

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
function mockSummary(req: LlmRequest): string {
  const user = [...req.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
  const heading = /^#\s+.+$/m.exec(user)
  const body = heading ? user.slice((heading.index ?? 0) + heading[0].length) : user
  return summarizeHeuristic(body, { sentences: 3 }).replace(/\s+/g, ' ').trim()
}

const llm = pickFor('summary', mockSummary)

const summaryChild = definePipeline({ id: 'practical-summary-child' })
  .use(createSummaryTool({ model: llm.model, call: llm.schemaCall }))
  .use(writeSummaries)
  .to('@chapters')

export default definePipeline({ id: 'practical-summary' })
  .from('@book2')
  .flatMap(async (markdown: unknown) => (chapterOnly(markdown) ? [String(markdown)] : []))
  .subflow('batch://?size=100', summaryChild)
