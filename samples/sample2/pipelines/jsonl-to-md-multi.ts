import { definePipeline, defineTool } from '@mt/core'
import type { MdOutputEntry } from '@mt/core'
import {
  type ParagraphTranslatorState,
  type TitleTranslatorInput,
  type TitleTranslatorState,
  chapterDoc,
  chapterIndexer,
  chapterValidator,
  createLlmGate,
  entitiesTool,
  forbiddenCharDetector,
  markdownFormatter,
  mdFormatter,
  mdOutputEmitter,
  mockLlmCall,
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
// Tools never name these roots: they emit write intents (subdir + filename) and
// the md:// target resolves them under whichever root the URI points at.

// === Stub translation tool (in-memory, no API call) ===
const stubTranslator = defineTool<string, string>({
  name: 'stub-translator',
  version: '1.0.0',
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

// Same build as schemaDocPipeline, but the emit slot is swapped for a mock writer:
// markdown is tagged and redirected to the target root's schema-mock subfolder.
const mockSchemaEmit = defineTool<string, string>({
  name: 'mock-schema-emit',
  version: '1.0.0',
  invoke: async (env, _ctx) => {
    const n = (env.meta.chapterNum as number | undefined) ?? 1
    const content = `<!-- mock-emit -->\n${env.item}`
    const existing = (env.meta.mdOutputs as MdOutputEntry[] | undefined) ?? []
    const mdOutputs = [
      ...existing,
      {
        name: 'schema-doc-mock',
        subdir: 'schema-mock',
        filename: `chapter${n}.mock.md`,
        content,
      },
    ]
    return { item: content, meta: { ...env.meta, mdOutputs } }
  },
})

export const schemaDocMockPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(toMarkdown)
  .use(chapterIndexer)
  .use(summaryTool)
  .use(entitiesTool)
  .use(schemaTool)
  .use(mdFormatter)
  .use(schemaDocWriter.with({ emit: mockSchemaEmit }))
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

// === LLM gate demo (offline): mock `call` slot + custom prompt + context shrink ===
// Gate = composable tool with slots prepare -> fit -> call -> parse -> emit.
// - prompts:  override the built-in 'summary' template (also possible via meta.prompts,
//             mt.json settings `prompts.summary`, or env MT_PROMPT_SUMMARY=text|@file)
// - context:  token budget + ordered shrink strategies for the `fit` slot
// - .with({ call: mockLlmCall(...) }) swaps the network call for a scripted answer (no API key)
const chapterSummaryGate = createLlmGate<
  { title: string; body: string; history: string[] },
  { content: string; model: string }
>({
  name: 'chapter-summary-gate',
  prompts: {
    summary: 'SAMPLE PROMPT - summarize in {{sentences}} sentences: {{text}}',
  },
  context: { maxTokens: 60, strategies: ['dropOldest', 'truncateLines'] },
  normalize: (input) => ({
    systemPrompt: 'You summarize book chapters.',
    // earlier turns the budget will trim (system + final prompt are always kept)
    messages: input.history.flatMap((h) => [
      { role: 'user' as const, content: h },
      { role: 'assistant' as const, content: `noted: ${h}` },
    ]),
    promptName: 'summary',
    vars: { sentences: 2, text: input.body },
  }),
}).with({
  call: mockLlmCall(
    (req) => `mock-summary(${req.messages.length} msgs): ${req.messages.at(-1)?.content}`,
  ),
})

// Record -> gate input (history is synthetic filler so the context budget has something to trim).
const toLlmGateInput = defineTool<{ title: string; body: string }, unknown>({
  name: 'to-llm-gate-input',
  version: '1.0.0',
  invoke: async (env, _ctx) => {
    const { title, body } = env.item
    const n = Number(title.match(/Chapter\s+(\d+)/i)?.[1] ?? 0)
    const history = Array.from({ length: 6 }, (_, i) => `earlier note ${i + 1} about ${title}`)
    return { item: { title, body, history }, meta: { ...env.meta, chapterNum: n } }
  },
})

// Gate output -> markdown, then the shared emit slot helper requests `<root>/llm/chapter<N>.llm.md`.
const llmSummaryToMd = defineTool<{ content: string; model: string }, string>({
  name: 'llm-summary-to-md',
  version: '1.0.0',
  invoke: async (env, _ctx) => {
    const cw = env.meta.contextWindow as { before: number; after: number } | undefined
    const md = `## LLM summary\n\n${env.item.content}\n\ncontext: ${cw?.before} -> ${cw?.after} tokens\n`
    return { item: md, meta: env.meta }
  },
})

export const llmGatePipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(toLlmGateInput)
  .use(chapterSummaryGate)
  .use(llmSummaryToMd)
  .use(
    mdOutputEmitter({
      name: 'llm-summary',
      subdir: 'llm',
      filename: (meta) => `chapter${meta.chapterNum}.llm.md`,
    }),
  )
  .to('md://./chapters')

// === Translate slot swap demo (offline): `.with({ translate })` on the chapter translators ===
// `.with({ translate })` replaces the translate slot of the composable translators with
// an offline mock — no API key, no router. The rest of each tool (extract/assemble,
// split/assemble) is untouched. (To swap in another `Tool<TranslateInput, TranslateOutput>`
// without writing a state-level slot, use `createTitleTranslator({ translate })` /
// `createParagraphTranslator({ translate })`.)
const titleTranslateSlotMock = defineTool<TitleTranslatorState, TitleTranslatorState>({
  name: 'title-translate-slot-mock',
  version: '1.0.0',
  invoke: async (env, _ctx) => ({
    item: env.item.title
      ? { ...env.item, translatedTitle: `[mock]${env.item.title}[/mock]` }
      : env.item,
    meta: env.meta,
  }),
})

const paragraphTranslateSlotMock = defineTool<ParagraphTranslatorState, ParagraphTranslatorState>({
  name: 'paragraph-translate-slot-mock',
  version: '1.0.0',
  invoke: async (env, _ctx) => ({
    item: { ...env.item, translated: env.item.paragraphs.map((p) => `[mock]${p}[/mock]`) },
    meta: env.meta,
  }),
})

const toChapterTranslateInput = defineTool<{ title: string; body: string }, TitleTranslatorInput>({
  name: 'to-chapter-translate-input',
  version: '1.0.0',
  invoke: async (env, _ctx) => {
    const { title, body } = env.item
    const n = Number(title.match(/Chapter\s+(\d+)/i)?.[1] ?? 0)
    return {
      item: { text: `# ${title}\n\n${body}`, targetLang: 'ru' },
      meta: { ...env.meta, chapterNum: n },
    }
  },
})

// Gate/tool output ({ text, ... }) -> markdown string for the md:// target.
const translateOutputToMd = defineTool<{ text: string }, string>({
  name: 'translate-output-to-md',
  version: '1.0.0',
  invoke: async (env, _ctx) => ({ item: env.item.text, meta: env.meta }),
})

export const translateSlotsMockPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(toChapterTranslateInput)
  .use(titleTranslator.with({ translate: titleTranslateSlotMock }))
  .use(paragraphTranslator.with({ translate: paragraphTranslateSlotMock }))
  .use(translateOutputToMd)
  .use(
    mdOutputEmitter({
      name: 'translate-mock',
      dir: 'chapters/translate-mock',
      filename: (meta) => `chapter${meta.chapterNum}.mock.md`,
    }),
  )
  .to('md://./chapters')

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
  .subflow(translateSlotsMockPipeline)
