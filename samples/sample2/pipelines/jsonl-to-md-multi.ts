import { definePipeline, defineTool } from '@mt/core'
import {
  chapterDoc,
  chapterIndexer,
  chapterValidator,
  entitiesTool,
  forbiddenCharDetector,
  markdownFormatter,
  mdFormatter,
  paragraphTranslator,
  schemaDocWriter,
  schemaTool,
  summaryTool,
  titleTranslator,
  toMarkdown,
  tokenCounter,
  tokenCounterBatch,
  tokenCounterBatchCached,
  tokenSplitter,
  typoFinder,
  wordCounter,
} from '@mt/tools'
import '@mt/waypoint'

// === URI shortcuts (aliases) ===
// Source/target URIs can be written as '@name' shortcuts instead of full URIs.
// Shortcuts are defined in this sample's mt.json under "uris", e.g.:
//   "uris": { "en": "md://./chapters/en", "ru": "chapter-output://./chapters" }
// They are resolved at pipeline run time; full URIs still work unchanged.

// === Stub translation tool (in-memory, no API call) ===
const stubTranslator = defineTool<string, string>({
  name: 'stub-translator',
  version: '1.0.0',
  exec: 'inproc',
  invoke: async (env, _ctx) => {
    const text = env.item as string
    // Simple stub: wrap paragraphs in [ru]...[/ru] markers
    const translated = text
      .split('\n\n')
      .map((p) => `[ru]${p}[/ru]`)
      .join('\n\n')
    return { ...env, item: translated, meta: { ...env.meta, translated: true, lang: 'ru' } }
  },
})

// === Flow 1: JSONL → Verified MD ===
const verifyFlow = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(chapterDoc)
  .use(wordCounter)
  .use(chapterIndexer)
  .use(chapterValidator)
  .use(forbiddenCharDetector)
  .use(tokenCounter)
  .tap(async (item: unknown) => {
    const meta = (item as { meta?: { errors?: unknown } }).meta
    console.log('[verify] errors:', meta?.errors)
  })
  .to('@en')

// === Flow 2: MD(EN) → MD(RU) translation ===
const translateFlow = definePipeline()
  .from('@en')
  .use(wordCounter)
  .use(chapterIndexer)
  .use(stubTranslator)
  .to('@ru')

// === Flow 3: token counting demo (batch-optimized tools) ===
// Batch tools consume a batched envelope (after `.batch(n)`); meta here is
// batch-level, so this flow targets ephemeral:// (no per-item file keying).
const countTokensFlow = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .flatMap(async (item: unknown) => {
    const record = item as { title: string; body: string }
    return [record.title, record.body]
  })
  .batch(5)
  .use(tokenCounterBatch)
  .tap(async (batch: unknown) => {
    const meta = (batch as { meta?: { tokenCount?: unknown } }).meta
    console.log('[tokens] batch total:', meta?.tokenCount)
  })
  .use(tokenCounterBatchCached)
  .to('ephemeral://tokens-output')

// === Named exports: each uses ephemeral:// source/target ===
export const smokeTestPipeline = definePipeline()
  .from('ephemeral://smoke-input')
  .use(chapterValidator)
  .tap(async (_item: unknown) => console.log('[smoke] chapter valid'))
  .to('ephemeral://smoke-output')

export const splitChaptersPipeline = definePipeline()
  .from('ephemeral://split-input')
  .use(tokenSplitter)
  .to('ephemeral://split-output')

export const collectWarningsPipeline = definePipeline()
  .from('ephemeral://warnings-input')
  .use(forbiddenCharDetector)
  .tap(async (item: unknown) => {
    const meta = (item as { meta?: { forbidden?: unknown } }).meta
    console.log('[forbidden]', meta?.forbidden)
  })
  .to('ephemeral://warnings-output')

export const schemaDocPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(toMarkdown)
  .use(chapterIndexer)
  .use(summaryTool)
  .use(entitiesTool)
  .use(schemaTool)
  .use(mdFormatter)
  .use(schemaDocWriter)
  .to('md://./chapters')

export const fixChapterPipeline = definePipeline()
  .from('ephemeral://fix-input')
  .use(typoFinder)
  .use(markdownFormatter)
  .to('ephemeral://fix-output')

export const translateTitlesPipeline = definePipeline()
  .from('ephemeral://titles-input')
  .batch(5)
  .use(titleTranslator)
  .flatMap(async (items: unknown) => (items as unknown[]) ?? [])
  .to('ephemeral://titles-output')

export const translateChapterPipeline = definePipeline()
  .from('ephemeral://translate-input')
  .flatMap(async (item: unknown) => {
    const record = item as { body: string; [k: string]: unknown }
    const paragraphs = record.body.split('\n\n')
    return paragraphs.map((p) => ({ ...record, body: p }))
  })
  .use(paragraphTranslator)
  .to('ephemeral://translate-output')

// === Default: orchestration pipeline (subflow-only) ===
export default definePipeline()
  .subflow(verifyFlow)
  .subflow(schemaDocPipeline)
  .subflow(smokeTestPipeline)
  .subflow(splitChaptersPipeline)
  .subflow(collectWarningsPipeline)
  .subflow(countTokensFlow)
  .subflow(fixChapterPipeline)
  .subflow(translateTitlesPipeline)
  .subflow(translateChapterPipeline)
  .subflow(translateFlow)
