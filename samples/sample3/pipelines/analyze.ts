import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { definePipeline, defineTool } from '@mt/core'
import {
  appendMdOutput,
  chapterNumberOf,
  chapterTitle,
  createGlossaryExtractor,
  createSummaryTool,
  heuristicSummaryTool,
  parseGlossary,
  termTagger,
} from '@mt/tools'
import '@mt/waypoint'
import { pickLlmTool } from './llm-picker.js'

// === Analyze stage: chapters/en/*.md -> summaries + glossary + <term>-tagged copies ===
// Everything is heuristic and offline by default. `MT_LLM_SUMMARY=1` additionally asks the
// picked LLM backend (see llm-picker.ts) for the summary and falls back to the heuristic one
// when the LLM reply is rejected.
//
// Outputs (under `chapters/`, written by the `@chapters` md target):
//   schema/chapter<N>.summary.md   per-chapter summary
//   glossary.json                  { terms: [{ id, term, type, count, firstChapter, ru, aliases }] }
//   en-tagged/chapter<N>.md        EN text with <term id="ID">text</term> around glossary terms
//
// glossary.json is meant to be edited by hand (fill `ru`, fix `type`, add `aliases`, list
// unwanted terms in `ignored`); re-running keeps every manual edit.

const ROOT = resolve(import.meta.dirname, '..')
const GLOSSARY_PATH = join(ROOT, 'chapters', 'glossary.json')

/** Existing glossary.json (undefined when absent or malformed). */
async function loadGlossary() {
  try {
    return parseGlossary(await readFile(GLOSSARY_PATH, 'utf-8'))
  } catch {
    return undefined
  }
}

const llm = pickLlmTool({
  mockSource: () => 'mock summary: the chapter introduces new characters and events.',
})

/** Optional LLM summary; every chapter the LLM could not summarise keeps its heuristic one. */
const llmSummary = (() => {
  const inner = createSummaryTool({ call: llm.schemaCall })
  return defineTool<string | string[], string | string[]>({
    name: 'llm-summary-with-fallback',
    version: '1.0.0',
    mdDescription: 'LLM summary through the picked backend; heuristic summary on fallback.',
    async invoke(env, ctx) {
      const out = await inner.invoke(env as never, ctx)
      const failed = (out.meta.summaryLlm as { fallbackUsed?: boolean } | undefined)?.fallbackUsed
      if (!failed) return out as never
      const heuristic = out.meta.heuristicSummaryByItem as string[]
      return {
        ...out,
        meta: { ...out.meta, summaryByItem: heuristic, summary: heuristic[0] },
      } as never
    },
  })
})()

const passThrough = defineTool<string | string[], string | string[]>({
  name: 'llm-summary-off',
  version: '1.0.0',
  mdDescription: 'Pass-through (set MT_LLM_SUMMARY=1 to enable the LLM summary).',
  async invoke(env) {
    return env
  },
})

/** Turns the analysis in `meta` into `meta.mdOutputs` write intents (one set per chapter). */
export const buildAnalyzeOutputs = defineTool<string | string[], string>({
  name: 'build-analyze-outputs',
  version: '1.0.0',
  mdDescription:
    'Emits chapters/schema/chapter<N>.summary.md, chapters/en-tagged/chapter<N>.md and chapters/glossary.json.',
  async invoke(env) {
    const inputs = (env.items ?? [env.item]).flat()
    const summaries = (env.meta.summaryByItem as string[] | undefined) ?? []
    const tagged = (env.meta.taggedItems as string[] | undefined) ?? []
    let meta: Record<string, unknown> = { ...env.meta }
    inputs.forEach((md, i) => {
      const n = chapterNumberOf(md, i + 1)
      const title = chapterTitle(md) || `Chapter ${n}`
      meta = appendMdOutput(meta, {
        name: 'summary',
        subdir: 'schema',
        filename: `chapter${n}.summary.md`,
        content: `# ${title}\n\n## Summary\n\n${summaries[i] ?? ''}\n`,
      })
      meta = appendMdOutput(meta, {
        name: 'en-tagged',
        subdir: 'en-tagged',
        filename: `chapter${n}.md`,
        content: tagged[i] ?? md,
      })
    })
    meta = appendMdOutput(meta, {
      name: 'glossary',
      subdir: '',
      filename: 'glossary.json',
      content: String(env.meta.glossaryJson ?? ''),
    })
    const glossary = env.meta.glossary as { terms: unknown[] } | undefined
    console.log(
      `[analyze] ${inputs.length} chapters, ${glossary?.terms.length ?? 0} glossary terms`,
    )
    return { item: '', meta }
  },
})

const analyzeFlow = definePipeline()
  .from('@en')
  .batch(100_000) // whole corpus in one group: the glossary is cross-chapter
  .use(heuristicSummaryTool)
  .use(process.env.MT_LLM_SUMMARY === '1' ? llmSummary : passThrough)
  .use(createGlossaryExtractor({ load: loadGlossary }))
  .use(termTagger)
  .use(buildAnalyzeOutputs)
  .to('@chapters')

export { analyzeFlow }
export default analyzeFlow
