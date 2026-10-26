import { join, resolve } from 'node:path'
import { definePipeline } from '@mt/core'
import {
  analyzeOutputs,
  createGlossaryExtractor,
  createLlmSummaryWithFallback,
  heuristicSummaryTool,
  pickLlmTool,
  readGlossaryFile,
  termTagger,
} from '@mt/tools'
import '@mt/waypoint'

// === Analyze stage: chapters/en/*.md -> summaries + glossary + <term>-tagged copies ===
// Everything is heuristic and offline by default. `MT_LLM_SUMMARY=1` additionally asks the
// picked LLM backend (`pickLlmTool` from @mt/tools) for the summary and falls back to the heuristic one
// when the LLM reply is rejected. `MT_LLM_GLOSSARY=1` does the same for the glossary: the terms of
// the previous `glossary.json` are reused (their `ru` / `type` win), only the new candidates are
// extracted, and the relations of the terms are built from the model answer.
//
// Outputs (under `chapters/`, written by the `@chapters` md target):
//   schema/chapter<N>.summary.md   per-chapter summary
//   glossary.json                  { terms: [{ id, term, type, count, firstChapter, ru, aliases, references? }] }
//   glossary.graph.json            { nodes: [...], edges: [...] } - the relation graph of the terms
//   en-tagged/chapter<N>.md        EN text with <term id="ID">text</term> around glossary terms
//
// glossary.json is meant to be edited by hand (fill `ru`, fix `type`, add `aliases`, list
// unwanted terms in `ignored`); re-running keeps every manual edit.

const ROOT = resolve(import.meta.dirname, '..')
const GLOSSARY_PATH = join(ROOT, 'chapters', 'glossary.json')

const llm = pickLlmTool({
  configPath: join(ROOT, 'mt.json'),
  mockSource: () => 'mock summary: the chapter introduces new characters and events.',
})

const glossaryLlm = process.env.MT_LLM_GLOSSARY === '1'

const analyzeFlow = definePipeline()
  .from('@en')
  .batch(100_000) // whole corpus in one group: the glossary is cross-chapter
  .use(heuristicSummaryTool)
  .use(
    createLlmSummaryWithFallback({
      call: llm.schemaCall,
      enabled: process.env.MT_LLM_SUMMARY === '1',
    }),
  )
  .use(
    createGlossaryExtractor({
      load: () => readGlossaryFile(GLOSSARY_PATH),
      call: glossaryLlm ? llm.schemaCall : undefined,
      model: llm.model,
      relations: { enabled: true, maxTerms: 4 },
    }),
  )
  .use(termTagger)
  .use(analyzeOutputs)
  .to('@chapters')

export { analyzeFlow }
export default analyzeFlow
