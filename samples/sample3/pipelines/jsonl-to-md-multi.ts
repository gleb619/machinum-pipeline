import { definePipeline, defineProcess, defineWaypoint, getVariable } from '@mt/core'
import {
  type LlmRequest,
  chapterDoc,
  chapterIndexer,
  chapterValidator,
  createApplyTranslatedTitle,
  createDictionaryTitleTranslator,
  createSchemaTitles,
  createTitlePacketParser,
  entitiesTool,
  forbiddenCharDetector,
  mdFormatter,
  mockLlm,
  paragraphTranslator,
  schemaDocWriter,
  schemaTool,
  stubSchemaEmit,
  summaryTool,
  titleTranslator,
  toMarkdown,
  tokenCounter,
  wordCounter,
} from '@mt/tools'
import '@mt/waypoint'
// Sample-defined scheme used by the `@ru` alias and the `my-target://` target below.
import '../waypoints/my-target.js'

// === LLM backend (process-level mock install) ===
// `defineProcess().install(mockLlm(...))` (see the default export at the bottom)
// installs a process-wide mock LLM provider at module load. Every LLM-backed tool
// below is built WITHOUT a `call` / `translate` argument and resolves the backend at
// invoke time: the installed mock when the picked backend is `mock` (default;
// `MT_LLM_TOOL` / mt.json `settings.llm.tool`), a real backend (`ollama`,
// `openrouter-free`, ...) when `MT_LLM_TOOL` names one - env wins over the mock.
// `pickLlmTool` stays exported for pipelines that prefer explicit wiring.

// === URI shortcuts (aliases) ===
// Source/target URIs can be written as '@name' shortcuts instead of full URIs.
// Shortcuts are defined in this sample's mt.json under "uris", e.g.:
//   "uris": { "en": "md://./chapters/en", "ru": "my-target://./chapters" }
// They are resolved at pipeline run time; full URIs still work unchanged.

// === Flow 1: JSONL → Verified MD (.from / .use / .tap / .to) ===
const verifyFlow = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(chapterDoc)
  .use(wordCounter)
  .use(chapterIndexer)
  .use(chapterValidator)
  .use(forbiddenCharDetector)
  .tap((ex) => console.log('[forbidden] findings:', getVariable(ex, 'forbidden')))
  .use(tokenCounter)
  .log('[verify]')
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
  .use(summaryTool)
  .use(entitiesTool)
  .use(schemaTool)
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
  .use(summaryTool)
  .use(entitiesTool)
  .use(schemaTool)
  .use(mdFormatter)
  .use(schemaDocWriter.with({ emit: stubSchemaEmit }))
  .to('md://./chapters')

// === Flow 3: title translation (.batch → mock-LLM tool → .flatMap) ===
// ephemeral:// sources carry no items at runtime; they exist to show the DSL grammar.
export const translateTitlesPipeline = definePipeline()
  .from('ephemeral://titles-input')
  .batch(5)
  .use(titleTranslator)
  .flatMap(async (items: unknown) => (items as unknown[]) ?? [])
  .to('ephemeral://titles-output')

// === Flow 4: paragraph translation (.flatMap fan-out → mock-LLM tool) ===
export const translateChapterPipeline = definePipeline()
  .from('ephemeral://translate-input')
  .flatMap(async (item: unknown) => {
    const record = item as { body: string; [k: string]: unknown }
    return record.body.split('\n\n').map((p) => ({ ...record, body: p }))
  })
  .use(paragraphTranslator)
  .to('ephemeral://translate-output')

// === Flow 5: packaged titles — ONE pipeline, a nested batch scope ===
//
// `.batch(scope)` folds the stream into packages of 5 (default) and runs `scope` once per package.
// Inside the scope the package is seen through waypoints:
//   batch://group    → the package as ONE item  (titles of all chapters → one text → parsed back)
//   batch://members  → every member as its own item, with its own meta (patch each chapter)
//   batch://return   → hands the result back; the outer stream continues with the ORIGINAL
//                      chapters (own id/meta/variables), patched, and `my-target://` writes them
// The group stage ends with `batch://return` so its variables (`translatedTitles`, ...) reach every
// member; the members stage then patches each chapter from them.
const enChapters = defineWaypoint<unknown>('my-target://./chapters', {
  filter: (env) => env.meta.lang === 'en',
})

const titleScope = definePipeline({ id: 'title-scope' })
  // stage 1 - package = one item: schema-doc titles → non-LLM dictionary translation → parsed packet
  // (`schemaTitles` reads `<schemaDir>/chapter<N>.schema.md` with `readDoc`, not the chapter H1)
  .from('batch://group')
  .use(createSchemaTitles({ schemaDir: 'chapters/schema' }))
  .use(
    createDictionaryTitleTranslator({
      dictionary: {
        chapter: 'Глава',
        the: '',
        road: 'Дорога',
        from: 'из',
        thornhaven: 'Тернхейвен',
        ambush: 'Засада',
        in: 'в',
        darkwood: 'Дарквуде',
        'duke’s': 'Герцога',
        "duke's": 'Герцога',
        tribunal: 'Трибунал',
      },
    }),
  )
  .use(createTitlePacketParser())
  .to('batch://return')
  // stage 2 - package = each item: stamp the translated title + `meta.lang=ru` on every chapter
  .from('batch://members')
  .use(createApplyTranslatedTitle({ lang: 'ru' }))
  .to('batch://return')

export const titlePacketPipeline = definePipeline()
  .from(enChapters)
  .batch(titleScope)
  .to('my-target://./chapters')

// === Default: orchestration pipeline (subflow-only, no source/target of its own) ===
// defineProcess().install(mockLlm(...)) registers the mock LLM provider process-wide
// at module load (before the Runner starts); .pipeline(...) returns the pipeline.
export default defineProcess()
  .install(
    mockLlm({
      source: (req: LlmRequest) =>
        `mock-answer(${req.messages.length} msgs): ${req.messages.at(-1)?.content}`,
    }),
  )
  .pipeline(
    definePipeline()
      .subflow(verifyFlow)
      .subflow(schemaDocPipeline)
      .subflow(titlePacketPipeline)
      .subflow(translateTitlesPipeline)
      .subflow(translateChapterPipeline),
  )
