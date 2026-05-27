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
  tokenSplitter,
  typoFixer,
  wordCounter,
} from '@mt/tools'
import '@mt/waypoint'

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
    return { ...env, item: translated, meta: { ...env.meta, translated: true } }
  },
})

// === Helper: convert JSONL record to plain markdown for schema-doc tools ===
//TODO: remove `toMarkdown` tool
//@depricated
const toMarkdown = defineTool<{ title: string; body: string }, string>({
  name: 'to-markdown',
  version: '1.0.0',
  exec: 'inproc',
  invoke: async (env, _ctx) => {
    const record = env.item as { title: string; body: string }
    return { ...env, item: `# ${record.title}\n\n${record.body}` }
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
  .tap(async (item: unknown) => {
    const meta = (item as { meta?: { warnings?: unknown } }).meta
    console.log('[verify] warnings:', meta?.warnings)
  })
  .to('md://./chapters/en')

// === Flow 2: MD(EN) → MD(RU) translation ===
const translateFlow = definePipeline()
  .from('md://./chapters/en')
  .use(wordCounter)
  .use(chapterIndexer)
  .use(stubTranslator)
  .to('chapter-output://./chapters')

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
    const meta = (item as { meta?: { warnings?: unknown } }).meta
    console.log('[warnings]', meta?.warnings)
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
  .use(typoFixer)
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
  .subflow(fixChapterPipeline)
  .subflow(translateTitlesPipeline)
  .subflow(translateChapterPipeline)
  .subflow(translateFlow)
