import { join } from 'node:path'
import { definePipeline, getVariable } from '@mt/core'
import {
  type LlmRequest,
  chapterDoc,
  chapterIndexer,
  chapterValidator,
  createEntitiesTool,
  createParagraphTranslator,
  createSchemaTool,
  createSummaryTool,
  createTitleTranslator,
  forbiddenCharDetector,
  mdFormatter,
  pickLlmTool,
  schemaDocWriter,
  stubSchemaEmit,
  toMarkdown,
  tokenCounter,
  wordCounter,
} from '@mt/tools'
import '@mt/waypoint'

// === LLM backend (single config point) ===
// `MT_LLM_TOOL` picks the backend (router | openrouter-free | openrouter-pool | ollama | mock),
// `MT_LLM_MODEL` the model; mt.json `settings.llm.tool` / `settings.llm.model` are the
// file-based fallback (env wins). Default is `mock`: offline, no API key, no router.
// Every LLM-backed tool below is wired to this one choice.
const llm = pickLlmTool({
  configPath: join(import.meta.dirname, '..', 'mt.json'),
  mockSource: (req: LlmRequest) =>
    `mock-answer(${req.messages.length} msgs): ${req.messages.at(-1)?.content}`,
})

// Schema-doc extractors (summary / entities / schema) and the chapter translators
// (title / paragraph) all run through the picked backend.
const summary = createSummaryTool({ model: llm.model, call: llm.schemaCall })
const entities = createEntitiesTool({ model: llm.model, call: llm.schemaCall })
const schema = createSchemaTool({ model: llm.model, call: llm.schemaCall })
const titles = createTitleTranslator({ translate: llm.translate })
const paragraphs = createParagraphTranslator({ translate: llm.translate })

// === URI shortcuts (aliases) ===
// Source/target URIs can be written as '@name' shortcuts instead of full URIs.
// Shortcuts are defined in this sample's mt.json under "uris", e.g.:
//   "uris": { "en": "md://./chapters/en", "ru": "chapter-output://./chapters" }
// They are resolved at pipeline run time; full URIs still work unchanged.

// === Flow 1: JSONL → Verified MD (.from / .use / .tap / .to) ===
const verifyFlow = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(chapterDoc)
  .use(wordCounter)
  .use(chapterIndexer)
  .use(chapterValidator)
  .use(forbiddenCharDetector)
  .use(tokenCounter)
  .tap(async (ex) => {
    console.log('[verify] errors:', getVariable(ex, 'errors'))
  })
  .to('@en')

// === Flow 2: JSONL → schema docs (mock-LLM summary / entities / schema) ===
// Writes <target root>/schema/chapter<N>.schema.md via the write intents the
// schemaDocWriter appends to the mdOutputs variable.
export const schemaDocPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(toMarkdown)
  .use(wordCounter)
  .use(tokenCounter)
  .use(chapterIndexer)
  .use(summary)
  .use(entities)
  .use(schema)
  .use(mdFormatter)
  .use(schemaDocWriter)
  .to('md://./chapters')

// === Slot override demo: `.with({ ... })` swaps one slot of a composable tool ===
// Same chain as schemaDocPipeline, but schemaDocWriter's `emit` slot is replaced by
// a stub that tags the markdown and redirects it to the schema-mock/ subfolder.
// The `build` slot (markdown assembly) is reused untouched. Run with:
//   mt run ./pipelines/jsonl-to-md-multi.ts --pipeline schemaDocMockPipeline
export const schemaDocMockPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(toMarkdown)
  .use(wordCounter)
  .use(tokenCounter)
  .use(chapterIndexer)
  .use(summary)
  .use(entities)
  .use(schema)
  .use(mdFormatter)
  .use(schemaDocWriter.with({ emit: stubSchemaEmit }))
  .to('md://./chapters')

// === Flow 3: title translation (.batch → mock-LLM tool → .flatMap) ===
// ephemeral:// sources carry no items at runtime; they exist to show the DSL grammar.
export const translateTitlesPipeline = definePipeline()
  .from('ephemeral://titles-input')
  .batch(5)
  .use(titles)
  .flatMap(async (items: unknown) => (items as unknown[]) ?? [])
  .to('ephemeral://titles-output')

// === Flow 4: paragraph translation (.flatMap fan-out → mock-LLM tool) ===
export const translateChapterPipeline = definePipeline()
  .from('ephemeral://translate-input')
  .flatMap(async (item: unknown) => {
    const record = item as { body: string; [k: string]: unknown }
    return record.body.split('\n\n').map((p) => ({ ...record, body: p }))
  })
  .use(paragraphs)
  .to('ephemeral://translate-output')

// === Default: orchestration pipeline (subflow-only, no source/target of its own) ===
export default definePipeline()
  .subflow(verifyFlow)
  .subflow(schemaDocPipeline)
  .subflow(translateTitlesPipeline)
  .subflow(translateChapterPipeline)
