import { join } from 'node:path'
import { type Source, type Target, definePipeline, getVariable } from '@mt/core'
import {
  type LlmRequest,
  chapterRecordMapper,
  createLlmTypoFix,
  lineTextToMarkdown,
  markdownFormatter,
  mdOutputEmitter,
  pickLlmTool,
  textNormalizer,
  typoFinder,
  unwrapMarkdownText,
} from '@mt/tools'
import '@mt/waypoint'

// === LLM backend (single config point, same pattern as sample2) ===
// `MT_LLM_TOOL` / `MT_LLM_MODEL` (or mt.json `settings.llm.*`) pick the backend; default is
// the offline `mock`, whose scripted answer echoes the text back unchanged.
// The LLM typo-fix step is OFF unless `MT_LLM_TYPO_FIX=1`: heuristics alone run offline.
const llm = pickLlmTool({
  configPath: join(import.meta.dirname, '..', 'mt.json'),
  mockSource: (req: LlmRequest) => req.messages.at(-1)?.content ?? '',
})

/**
 * The full normalize tool chain with injectable endpoints — `normalize.ts` plugs in the plain
 * URIs, `waypoint-log.ts` plugs in `defineWaypoint`-wrapped source/target with audit-log hooks.
 */
export function buildNormalizeFlow(
  source: Source<unknown> | string,
  target: Target<unknown> | string,
) {
  return definePipeline()
    .from(source)
    .use(chapterRecordMapper)
    .use(textNormalizer)
    .use(createLlmTypoFix({ call: llm.schemaCall, enabled: process.env.MT_LLM_TYPO_FIX === '1' }))
    .use(lineTextToMarkdown)
    .use(typoFinder)
    .tap(async (ex) => {
      const warnings = getVariable<unknown[]>(ex, 'warnings')
      console.log(`[normalize] chapter ${ex.meta.chapterNum}: ${warnings?.length ?? 0} typo hints`)
    })
    .use(markdownFormatter)
    .use(unwrapMarkdownText)
    .use(
      mdOutputEmitter({
        name: 'normalized',
        filename: (meta) => `chapter${meta.chapterNum}.md`,
      }),
    )
    .to(target)
}

const normalizeFlow = buildNormalizeFlow('jsonl://./jsonl/input.jsonl', '@en')

export { normalizeFlow }
export default normalizeFlow
