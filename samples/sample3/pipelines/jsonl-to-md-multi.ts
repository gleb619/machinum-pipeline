import { definePipeline, defineProcess, defineWaypoint, getVariable, log } from '@mt/core'
import {
  type LlmRequest,
  chapterDoc,
  chapterIndexer,
  chapterValidator,
  createApplyTranslatedTitle,
  createChapterBodyTranslator,
  createDictionaryTitleTranslator,
  createLlmTypoFix,
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
// Sample-defined scheme behind the `@ru` alias and `my-target://`.
import '../waypoints/my-target.js'

// LLM-backed tools below get no `call`/`translate`: the backend resolves at invoke time - the
// mock installed by the default export (`MT_LLM_TOOL` / mt.json `settings.llm.tool`), or a real
// backend when `MT_LLM_TOOL` names one (env wins).
// '@en' / '@ru' are URI shortcuts from this sample's mt.json "uris"; full URIs still work.

// Flow 1: JSONL → verified MD
const verifyFlow = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(chapterDoc)
  .use(wordCounter)
  .use(chapterIndexer)
  .use(chapterValidator)
  .use(forbiddenCharDetector)
  .tap((ex) => log.info('[forbidden] findings:', { findings: getVariable(ex, 'forbidden') }))
  .use(tokenCounter)
  .log('MyLogMarker')
  .to('@en')

// Flow 2: JSONL → <target>/schema/chapter<N>.schema.md (mock-LLM summary / entities / schema)
const schemaDocs = (writer: typeof schemaDocWriter) =>
  definePipeline()
    .from('jsonl://./jsonl/input.jsonl')
    .use(toMarkdown)
    .use(wordCounter)
    .use(tokenCounter)
    .use(chapterIndexer)
    .use(summaryTool)
    .use(entitiesTool)
    .use(schemaTool)
    .use(mdFormatter)
    .use(writer)
    .to('md://./chapters')

export const schemaDocPipeline = schemaDocs(schemaDocWriter)

// Slot override: `.with({ ... })` swaps one slot of a composable tool. Here `emit` becomes a stub
// that redirects to schema-mock/; the `build` slot is reused untouched.
//   mt run ./pipelines/jsonl-to-md-multi.ts --pipeline schemaDocMockPipeline
export const schemaDocMockPipeline = schemaDocs(schemaDocWriter.with({ emit: stubSchemaEmit }))

// Flow 3: title translation (.batch → mock-LLM tool → .flatMap)
// ephemeral:// sources carry no items at runtime; they only show the DSL grammar.
export const translateTitlesPipeline = definePipeline()
  .from('ephemeral://titles-input')
  .batch(5)
  .use(titleTranslator)
  .flatMap(async (items: unknown) => (items as unknown[]) ?? [])
  .to('ephemeral://titles-output')

// Flow 4: paragraph translation (.flatMap fan-out → mock-LLM tool)
export const translateChapterPipeline = definePipeline()
  .from('ephemeral://translate-input')
  .flatMap(async (item: unknown) => {
    const record = item as { body: string; [k: string]: unknown }
    return record.body.split('\n\n').map((p) => ({ ...record, body: p }))
  })
  .use(paragraphTranslator)
  .to('ephemeral://translate-output')

// Flow 5: chapter body translation (glossary + summary injection), written via `my-target://`
export const translateChapterBodyPipeline = definePipeline()
  .from('ephemeral://chapter-body-input')
  .use(createChapterBodyTranslator({ chaptersDir: 'chapters', mode: 'plain' }))
  .to('my-target://./chapters')

// Flow 6: post-translation typo fix (LLM retry, falls back to the original on failure)
export const fixTyposPipeline = definePipeline()
  .from('ephemeral://typo-input')
  .use(createLlmTypoFix({ maxAttempts: 2 }))
  .to('ephemeral://typo-output')

// Flow 7: packaged titles - ONE pipeline, a nested `.batch(scope)` (packages of 5 by default).
// Inside the scope the package is seen through waypoints:
//   batch://group    → the package as ONE item (all titles → one text → parsed back)
//   batch://members  → each member as its own item, with its own meta
//   batch://return   → hands the result back; the outer stream continues with the ORIGINAL
//                      chapters, patched. The group stage's variables reach every member.
const enChapters = defineWaypoint<unknown>('my-target://./chapters', {
  filter: (env) => env.meta.lang === 'en',
})

const titleScope = definePipeline({ id: 'title-scope' })
  // stage 1 - package = one item: schema-doc titles → dictionary translation (no LLM) → packet
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
  // stage 2 - package = each item: stamp the translated title + `meta.lang=ru`
  .from('batch://members')
  .use(createApplyTranslatedTitle({ lang: 'ru' }))
  .to('batch://return')

export const titlePacketPipeline = definePipeline()
  .from(enChapters)
  .batch(titleScope)
  .to('my-target://./chapters')

// Default: orchestration only. `.install(mockLlm(...))` registers the mock LLM process-wide
// before the Runner starts.
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
      .subflow(translateChapterPipeline)
      .subflow(translateChapterBodyPipeline)
      .subflow(fixTyposPipeline),
  )
