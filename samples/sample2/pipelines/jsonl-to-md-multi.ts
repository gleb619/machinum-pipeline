import { join } from 'node:path'
import { definePipeline, defineTool, getVariable, registry, withItem } from '@mt/core'
import type { MdOutputEntry, ParsedUri, RunEvent, Target, TargetContext } from '@mt/core'
import {
  type LlmRequest,
  type ParagraphTranslatorState,
  type TitleTranslatorInput,
  type TitleTranslatorState,
  chapterDoc,
  chapterIndexer,
  chapterValidator,
  createEntitiesTool,
  createLlmGate,
  createParagraphTranslator,
  createSchemaTool,
  createSummaryTool,
  createTitleTranslator,
  forbiddenCharDetector,
  installStubs,
  markdownFormatter,
  mdFormatter,
  mdOutputEmitter,
  paragraphTranslator,
  pickLlmTool,
  schemaDocWriter,
  stubParagraphTranslateSlot,
  stubSchemaEmit,
  stubTitleTranslateSlot,
  stubTranslator,
  titleTranslator,
  toMarkdown,
  tokenCounter,
  tokenCounterBatch,
  tokenCounterBatchCached,
  tokenSplitter,
  typoFinder,
  wordCounter,
} from '@mt/tools'
import { createMdTarget } from '@mt/waypoint'
import '@mt/waypoint'

// === LLM backend (single config point) ===
// `MT_LLM_TOOL` picks the backend (router | openrouter-free | openrouter-pool | ollama | mock),
// `MT_LLM_MODEL` the model; mt.json `settings.llm.tool` / `settings.llm.model` are the
// file-based fallback (env wins). Default is `mock`: offline, no API key, no router.
// Every LLM-backed tool below is wired to this one choice.
const llm = pickLlmTool({
  configPath: join(import.meta.dirname, '..', 'mt.json'),
  mockSource: (req: LlmRequest) =>
    `mock-summary(${req.messages.length} msgs): ${req.messages.at(-1)?.content}`,
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
// Tools never name these roots: they emit write intents (subdir + filename) and
// the md:// target resolves them under whichever root the URI points at.

// === Flow 1: JSONL → Verified MD ===
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

// === Flow 2: MD(EN) → MD(RU) translation ===
const translateFlow = definePipeline()
  .from('@en')
  .use(wordCounter)
  .use(chapterIndexer)
  .use(stubTranslator)
  .to('@ru')

// === Install stubs for dry runs ===
// Call installStubs() to swap real tool slots with stub implementations.
// Uncomment the line below to enable dry-run mode (no API calls, no LLM).
// installStubs()

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
  .tap(async (batch) => {
    console.log('[tokens] batch total:', getVariable(batch, 'tokenCount'))
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
  .tap(async (ex) => {
    console.log('[forbidden]', getVariable(ex, 'forbidden'))
  })
  .to('ephemeral://warnings-output')

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

// Same build as schemaDocPipeline, but the emit slot is swapped for a mock writer:
// markdown is tagged and redirected to the target root's schema-mock subfolder.
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

export const fixChapterPipeline = definePipeline()
  .from('ephemeral://fix-input')
  .use(typoFinder)
  .use(markdownFormatter)
  .to('ephemeral://fix-output')

export const translateTitlesPipeline = definePipeline()
  .from('ephemeral://titles-input')
  .batch(5)
  .use(titles)
  .flatMap(async (items: unknown) => (items as unknown[]) ?? [])
  .to('ephemeral://titles-output')

export const translateChapterPipeline = definePipeline()
  .from('ephemeral://translate-input')
  .flatMap(async (item: unknown) => {
    const record = item as { body: string; [k: string]: unknown }
    const parts = record.body.split('\n\n')
    return parts.map((p) => ({ ...record, body: p }))
  })
  .use(paragraphs)
  .to('ephemeral://translate-output')

// === LLM gate demo (offline): picked `call` slot + custom prompt + context shrink ===
// Gate = composable tool with slots prepare -> fit -> call -> parse -> emit.
// - prompts:  override the built-in 'summary' template (also possible via the `prompts` variable,
//             mt.json settings `prompts.summary`, or env MT_PROMPT_SUMMARY=text|@file)
// - context:  token budget + ordered shrink strategies for the `fit` slot
// - .with({ call: llm.gate.slots.call }) takes the `call` slot of the picked backend
//             (mock by default: a scripted answer, no API key, no router)
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
    // the picked model wins over the gate's own default
    model: llm.model,
  }),
}).with({
  call: llm.gate.slots.call,
})

// Record -> gate input (history is synthetic filler so the context budget has something to trim).
const toLlmGateInput = defineTool<{ title: string; body: string }, unknown>({
  name: 'to-llm-gate-input',
  version: '1.0.0',
  mdDescription: 'Markdown description',
  invoke: async (env, _ctx) => {
    const { title, body } = env.item
    const n = Number(title.match(/Chapter\s+(\d+)/i)?.[1] ?? 0)
    const history = Array.from({ length: 6 }, (_, i) => `earlier note ${i + 1} about ${title}`)
    return { ...withItem(env, { title, body, history }), meta: { ...env.meta, chapterNum: n } }
  },
})

// Gate output -> markdown, then the shared emit slot helper requests `<root>/llm/chapter<N>.llm.md`.
const llmSummaryToMd = defineTool<{ content: string; model: string }, string>({
  name: 'llm-summary-to-md',
  version: '1.0.0',
  mdDescription: 'Markdown description',
  invoke: async (env, _ctx) => {
    const cw = getVariable<{ before: number; after: number }>(env, 'contextWindow')
    const md = `## LLM summary\n\n${env.item.content}\n\ncontext: ${cw?.before} -> ${cw?.after} tokens\n`
    return withItem(env, md)
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
// Alternative: call `installStubs()` at module top to auto-swap all stub slots at once.
const toChapterTranslateInput = defineTool<{ title: string; body: string }, TitleTranslatorInput>({
  name: 'to-chapter-translate-input',
  version: '1.0.0',
  mdDescription: 'Markdown description',
  invoke: async (env, _ctx) => {
    const { title, body } = env.item
    const n = Number(title.match(/Chapter\s+(\d+)/i)?.[1] ?? 0)
    return {
      ...withItem(env, { text: `# ${title}\n\n${body}`, targetLang: 'ru' }),
      meta: { ...env.meta, chapterNum: n },
    }
  },
})

// Gate/tool output ({ text, ... }) -> markdown string for the md:// target.
const translateOutputToMd = defineTool<{ text: string }, string>({
  name: 'translate-output-to-md',
  version: '1.0.0',
  mdDescription: 'Markdown description',
  invoke: async (env, _ctx) => withItem(env, env.item.text),
})

export const translateSlotsMockPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(toChapterTranslateInput)
  .use(titleTranslator.with({ translate: stubTitleTranslateSlot }))
  .use(paragraphTranslator.with({ translate: stubParagraphTranslateSlot }))
  .use(translateOutputToMd)
  .use(
    mdOutputEmitter({
      name: 'translate-mock',
      subdir: 'translate-mock',
      filename: (meta) => `chapter${meta.chapterNum}.mock.md`,
    }),
  )
  .to('md://./chapters')

// === Run lifecycle events demo (RunEvents) ===
// A pipeline module is a real TS module — it can register its own URI schemes.
// `log-md://` wraps the built-in `md://` target and shows how a Source/Target
// listens to the run's lifecycle events via `ctx.events?.subscribe(...)`:
// started / step-done / paused / resumed / done / failed. Each event prints
// one custom log line. Unsubscribe in `close()` — it also runs on failure.
// (This is the same facade the `http-server` source uses to mirror lifecycle
// events to its SSE subscribers.)
// Run it:  mt run pipelines/jsonl-to-md-multi.ts --pipeline lifecycleLogPipeline
const createLifecycleLogTarget = <T>(uri: ParsedUri): Target<T> => {
  // Delegate all actual writing to the built-in md target.
  const inner = createMdTarget<T>({ ...uri, scheme: 'md', raw: uri.raw.replace(/^log-md:/, 'md:') })
  let unsubscribe: (() => void) | undefined
  return {
    uri: uri.raw,
    async open(ctx: TargetContext): Promise<void> {
      unsubscribe = ctx.events?.subscribe((event: RunEvent) => {
        const step = event.stepId ? ` step=${event.stepId}` : ''
        const error = event.error ? ` error=${event.error}` : ''
        const line = `[lifecycle] ${event.type}${step}${error}`
        // `ctx.run.logger` writes to .mt/runs/<id>/logs/<step>.log;
        // console.log makes the line visible live during `mt run`.
        ctx.run.logger.info(line)
        console.log(line)
      })
      await inner.open(ctx)
    },
    async write(env, ctx): Promise<void> {
      await inner.write(env, ctx)
    },
    async close(ctx): Promise<void> {
      unsubscribe?.()
      unsubscribe = undefined
      await inner.close(ctx)
    },
  }
}
registry.registerTarget('log-md', createLifecycleLogTarget)

export const lifecycleLogPipeline = definePipeline()
  .from('jsonl://./jsonl/input.jsonl')
  .use(chapterDoc)
  .use(chapterIndexer)
  .to('log-md://./chapters/lifecycle')

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
