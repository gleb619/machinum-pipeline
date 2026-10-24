# @mt/tools
← [Architecture](../architecture.md)

Path: `packages/tools/`

Chapter processing tools for validation, translation, schema extraction, and formatting. All tools are `defineTool()` instances exported from `src/index.ts`. Tools operate on `Envelope<Chapter>` or domain-specific envelope types.

## Tool Catalogue

### `chapter-validator.ts`
- `chapterValidator` — structural markdown validation (heading hierarchy, code block languages, link integrity)
- `forbiddenCharDetector` — finds zero-width chars, forbidden control chars
- `typoFinder` — detects common Chinese/English typos, mixed scripts

### `chapter-doc.ts`
Reads/writes chapter YAML-frontmatter documents (`.chapter-doc.yml`). Internal format for passing per-chapter metadata between tools. Exports: `readChapterDoc`, `writeChapterDoc`, `chapterDoc` (composable tool: slots `build` + `emit` -> `chapters/en`).

### `schema-doc.ts` + `schema/`
LLM-powered schema document generation. The mdshape document format (`SchemaDocEnvelope`, `readDoc`,
`writeDoc`, `schemaDocWriter`) lives in `schema-doc.ts` and stays pure; the five extraction tools live in
`packages/tools/src/schema/`, one file each:

- `summary.ts` — `summaryTool` / `createSummaryTool` → `meta.summary`
- `entities.ts` — `entitiesTool` / `createEntitiesTool` → `meta.entities`
- `schema.ts` — `schemaTool` / `createSchemaTool` → `meta.schema` (mermaid)
- `metadata.ts` — `metadataTool` / `createMetadataTool` → `meta.metadata`
- `vocabulary.ts` — `vocabularyTool` / `createVocabularyTool` → `meta.vocabulary`, `meta.knownWords`

Each calls `runPromptWithRetry` (`schema/llm.ts`), which wraps `chatCompletionSingle` from
`openrouter-tool.ts` against `ctx.run.global.routerUrl`. Shared pieces: `schema/doc.ts` (chapter parsing,
prompt rendering, CSV/table parsers, mdshape round-trip check) and `schema/llm.ts` (retry loop guard).

**Loop guard:** a reply must be non-empty, parse as mdshape, and keep the section's required content (key
terms covered, entities/terms present in the chapter, diagram keyword + edges, metadata counters unchanged).
Rejections are re-prompted with the reason appended, max 3 attempts, then the deterministic fallback (the
value already in the document, else the pre-LLM heuristic) so the run never hard-fails. `meta.<tool>Llm`
records `attempts`, `tokens`, `model`, `fallbackUsed`, `lastFailure`.

**Configuration:** `create*Tool({ model, temperature, maxTokens, systemPrompt, userPrompt, maxAttempts,
routerUrl })`, default model `openai/gpt-4o-mini`; per-envelope overrides via `meta.schemaDocLlm` and
`meta.<key>Prompt` / `meta.<key>SystemPrompt`. Templates render `{{title}}`, `{{body}}`, `{{chapter}}`, …
Batched envelopes store per-item results in `meta.<key>ByItem`.

- `schemaDocWriter` — persists to `schema-doc://` target (pure, no LLM call)

Envelope type: `SchemaDocEnvelope`.

### `translate-text.ts`
- `translateText` / `createTranslateText(opts)` — composable translation tool (slots `prepare, fit, call,
  parse, emit`). Default `call` backend POSTs `/api/translate` on the MT router proxy (legacy behaviour and
  error messages kept); `backend: 'llm'` routes through the LLM toolkit (`resolveLlmConfig` provider,
  prompts `translate.system` / `translate.user`). Options: `TranslateTextOptions` (`targetLang`, `backend`,
  `llm`, `routerUrl`, `prompts`); legacy `TranslateToolConfig` type kept for compatibility.
  `llmTranslate` (`llm-translate.ts`) shares this one implementation with the `llm` backend.

### `chapter-translator.ts`
Higher-level translation tools, composable:
- `titleTranslator` / `createTitleTranslator({ translate })` — slots `extract -> translate -> assemble`
  (title from frontmatter, H1, or first line).
- `paragraphTranslator` / `createParagraphTranslator({ translate })` — slots `split -> translate -> assemble`.

The `translate` slot defaults to `translateText`; all invocations go through one shared helper
(`translateVia`, no hand-built envelopes). Swap the translator for the whole tool either via the factory
option (any `Tool<TranslateInput, TranslateOutput>`) or per-slot via `.with({ translate })`.

### `openrouter-tool.ts`
LLM gates built on the LLM toolkit (see [LLM toolkit](#llm-toolkit)); I/O unchanged:
- `chatCompletion` — chat completion (composable: `prepare, fit, call, parse, emit`)
- `runPrompt` — simplified prompt runner
- `chatCompletionSingle`, `resolveRouterUrl` — direct one-shot helper / router URL resolution

Default provider is the MT router proxy (`/api/chat/completions`). The key pool from `openrouter-pool.ts`
(round-robin, 429/402) is used by the `openrouter` provider.

### `md-formatter.ts`
- `mdFormatterTool` — reformats markdown with configurable line width. Uses remark/unified under the hood.

### `fs-read.ts` / `fs-write.ts`
The only modules allowed to touch `node:fs`: `fs-read.ts` owns all reads (`readTextFile`,
`readTextFileSync`, `readDirectory`, `isDirectory`); `fs-write.ts` delegates atomic writes to
`@mt/core` (`atomicWriteFile`, temp-then-rename). Everything else in `src/` goes through these two.

### `token-splitter.ts`
Splits text at paragraph boundaries respecting a token limit. Uses heuristic token counting (`heuristicTokenCount`).

### `word-counter.ts`
- `wordCounter` — counts words in an envelope, adds to metadata.

### `chapter-indexer.ts`
Assigns ordering indexes to chapters based on filename patterns.

### `token-counter.ts`
Token counting via tiktoken (`cl100k_base`):
- `tokenCounter` — counts tokens of a string envelope item, adds `tokenCount` to meta. Creates/frees the encoder on every call (clean, no shared state).
- `tokenCounterBatch` — for batched envelopes (after `.batch(n)`): one encoder create/free per batch invoke. Adds `tokenCounts` (per item) and `tokenCount` (batch total) to meta.
- `tokenCounterBatchCached` — same batch semantics, but reuses one process-wide cached encoder, freed via a `process.on('exit')` hook (one create/free per process). Use for large runs where encoder construction dominates.

## LLM toolkit

Files: `llm-client.ts` (types, adapters, `createLlmClient`), `llm-decorators.ts`, `llm-errors.ts`,
`llm-config.ts`, `llm-prompts.ts`, `llm-context.ts`, `llm-gate.ts`, `llm-translate.ts`,
`llm-sdk-transports.ts`. Plan: [plans/llm-toolkit.md](../plans/llm-toolkit.md).

**Layers:** adapter (`OpenAiCompatClient`: OpenAI/OpenRouter/Ollama/router/custom, `AnthropicClient`; fetch-based behind an
injectable `LlmTransport`, no SDK dep) or the official SDK adapters (`createOpenAiSdkClient`, `createAnthropicSdkClient`
in `llm-sdk-transports.ts`; `openai` / `@anthropic-ai/sdk` loaded lazily via dynamic `import()`, minimal structural local
interfaces, same typed error mapping incl. pool 429-block/402-disable) -> `withTimeout` (per-call timeout + `AbortSignal`) -> `withLlmRetry`
(core `withRetry`; only 429/5xx/network/timeout; policy = `ctx.run.global.defaults.retry`) -> `withCache` (core `Cache`,
stable key, opt-in). Typed errors: `LlmRateLimitError` (with `retryAfterMs`), `LlmAuthError`, `LlmQuotaError` (402), `LlmContextLengthError`,
`LlmServerError`, `LlmNetworkError`, `LlmTimeoutError`, `LlmAbortError`, `LlmParseError`. Secrets are never logged
(`redactLlmConfig`), and `apiKey` is never read from `meta` (checkpointed).

`LlmClient.chatCompletionStream?(req, onDelta?)` optionally aggregates content deltas (final usage included);
the non-streaming `chatCompletion` path is unchanged.

### LLM config precedence (`resolveLlmConfig`, pure)

First defined wins, per field: **call input** (`item.llm`, `item.model`) > **tool option** (`createLlmGate({ llm })`) >
**`meta.llm`** > **mt.json `settings`** (`llm.provider`, `llm.model`, `llm.baseUrl`, `llm.apiKey`, `llm.timeoutMs`, `llm.retry`, `llm.cache`) >
**env** > **default**.

| Field | Env | Default |
|---|---|---|
| provider | `MT_LLM_PROVIDER` | `router` (never inferred from keys) |
| model | `MT_LLM_MODEL` | `openai/gpt-4o-mini` (router/openrouter), `gpt-4o-mini`, `llama3.1`, `claude-haiku-4-5` |
| baseUrl | `MT_LLM_BASE_URL`; router: `ctx.routerUrl`, `MT_ROUTER_URL` | provider URL; router `http://localhost:7777` |
| apiKey(s) | `MT_LLM_API_KEY`, `OPENROUTER_API_KEYS` (pool), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | none |
| timeoutMs | `MT_LLM_TIMEOUT_MS` | 120000 |
| retry | (layers) then `ctx.defaults.retry` | `{max:3, backoffMs:1000, strategy:'exp'}` |
| cache | `MT_LLM_CACHE` | off |
| transport | `MT_LLM_TRANSPORT`, settings `llm.transport` | `sdk` when the provider SDK is resolvable, else `fetch`; `router` always `fetch` |

### Prompt precedence (`resolvePrompt(name, vars, sources, env)`)

**tool option** (`createLlmGate({ prompts: { name: text } })`) > **`meta.prompts[name]`** > **settings `prompts.<name>`** >
**env `MT_PROMPT_<NAME>`** (`.`/`-` -> `_`, upper-case) > **registered default**. A value starting with `@` is a file path
(relative to the project root). Templates use `{{var}}`; a missing var throws `PromptVariableError`.
Defaults: `translate.system`, `translate.user`, `summary`, `entities`, `context.summarize`, `json.correction`
(`registerPrompt()` adds more).

### Context window (`contextWindow` tool, `fit` slot)

Budget = `min(maxTokens, contextLimit - reserve)`; no budget = no-op. Precedence: **item `context`** > **factory options** >
**`meta.context`** > **settings `context.*`** > **env** (`MT_CONTEXT_MAX_TOKENS`, `MT_CONTEXT_LIMIT`, `MT_CONTEXT_RESERVE`,
`MT_CONTEXT_STRATEGIES`). Strategies run in order until the messages fit; system messages and the last user message are
protected by default. Built-ins: `truncateLines`, `truncateTail`, `truncateHead`, `summarize` (LLM, prompt `context.summarize`,
falls back to `dropOldest`), `dropOldest`, `dropMiddle`, `slidingWindow`; custom: pass a `ShrinkStrategy`
(`{ name, apply(messages, budget, helpers) }`) or `registerShrinkStrategy(name, factory)`. Token counting is injectable
(`countTokens`, default `countTextTokens` from `token-counter.ts`). Records `meta.contextWindow`
`{before, after, budget, fits, applied[{name,before,after,note?}]}`.

**Oversize last user message** (`lastMessage`, default `off`): strategies protect the final user message from
shrinking, so a single oversize message can exceed the budget. `lastMessage: 'truncate'` keeps head+tail with an
elision marker, `'summarize'` rewrites it via the `context.summarize` prompt (needs an LLM), `'error'` throws a
clear `LlmContextLengthError`; the result is still reported in `meta.contextWindow.applied` (`truncateLastMessage` /
`summarizeLastMessage`). The system message is never dropped. Config: settings `context.lastMessage` /
`MT_CONTEXT_LAST_MESSAGE`.

**Model context limits (`autoLimit`, default on):** when the model id is known, the budget is derived from the
maintained `MODEL_CONTEXT_LIMITS` table (major OpenAI/Anthropic/Google/Meta/Mistral/DeepSeek/Qwen families;
prefix/glob match incl. `provider/model` OpenRouter ids) minus `reserve` — no explicit `maxTokens` needed.
Extend/override via mt.json `context.limits` or `MT_CONTEXT_LIMITS` (`{"glob": tokens}` JSON), disable with
`context.autoLimit: false` / `MT_CONTEXT_AUTO_LIMIT=0`.

### Gates and swapping a slot

`createLlmGate(opts)` = `defineComposableTool` with slots `prepare -> fit -> call -> parse -> emit` (state travels as
`GateState` in `env.item`). Reliability: JSON mode (`responseFormat: 'json'`) parses with bounded corrective retries
(`jsonRetries`, default 2), `shrinkOnContextError` re-fits via the `fit` slot and retries on `LlmContextLengthError`,
usage/cost land in `meta.llmUsage`. `stream: true` (+ optional `onDelta(delta, input)`) makes the `call` slot use
`chatCompletionStream` when the transport supports it; the aggregated output and envelope shape are identical to
non-streaming.

```typescript
import { chatCompletion, createLlmGate, mockLlmCall } from '@mt/tools'

// swap `call` for a mock (tests/samples), original stays intact
.use(chatCompletion.with({ call: mockLlmCall(['answer 1', (req) => `echo ${req.model}`]) }))

// custom gate: own prompt, context budget, provider; swap only `fit`
const gate = createLlmGate({
  name: 'my-gate',
  llm: { provider: 'openai', model: 'gpt-4o-mini' },
  prompts: { summary: '@prompts/summary.md' },
  context: { maxTokens: 6000, strategies: ['truncateLines', 'summarize', 'dropOldest'] },
  shrinkOnContextError: true,
})
.use(gate.with({ fit: myFitTool }))   // any Tool or fn(env, ctx)
```

Tests: `tests/llm-*.test.ts`. Samples: `samples/sample2` `llmGatePipeline` (mock `call` slot) and
`translateSlotsMockPipeline` (`.with({ translate })` on `titleTranslator`/`paragraphTranslator`, offline mock).

## Key Patterns

**Tool signature:**
```typescript
export const myTool = defineTool<Input, Output>({
  name: 'my-tool',
  version: '1.0.0',
  mdDescription: 'Tool purpose in Markdown.',
  async invoke(env, ctx) {
    // transform env.item
    return { ...env, item: result }
  },
})
```

**Composable tools / overridable parts** (`md-outputs.ts`, core `defineComposableTool`):
```typescript
export const myDoc = defineComposableTool({
  name: 'my-doc', version: '1.0.0', mdDescription: '...',
  slots: {
    build: myBuildTool,                                        // pure: meta -> markdown
    emit: mdOutputEmitter({ name: 'my-doc', dir: 'chapters/x', filename: (m) => `c${m.chapterNum}.md` }),
  },
})
// pipeline author: reuse build, replace emit (any Tool or fn); original stays intact
.use(myDoc.with({ emit: mockEmit }))
```
`appendMdOutput(meta, entry)` is the shared non-mutating `meta.mdOutputs` append; `mdOutputEmitter` supports `when()` to skip.
New tools that write md should expose `build`/`emit` slots instead of hardcoding both. Tests: `tests/composition.test.ts`.

**OpenRouter pool** (`openrouter-pool.ts`):
- Round-robin across `OPENROUTER_API_KEYS` (comma-separated env var)
- 429 → marks key exhausted until TTL
- 402 → removes key permanently
- Pool recreates on TTL expiry

## Tests

Tests live in `packages/tools/tests/`:
- `chapter-doc.test.ts` — unit tests for doc read/write
- `schema-doc.test.ts` — schema-doc format tests (`readDoc` / `writeDoc` round-trip)
- `schema/prompt-retry.test.ts` — `runPromptWithRetry` loop guard, retries and attempt budget
- `schema/tools.test.ts` — the five extraction tools against a stubbed router, fallbacks included
- `schema/mock-router.ts` — shared `fetch` stub and chapter fixtures (helper, not a test file)
- `md-formatter.test.ts` — formatter output tests
- `translate-text.test.ts` — translation tests (requires `OPENROUTER_API_KEYS`)
- `translate-slots.test.ts` — composable translateText / titleTranslator / paragraphTranslator (slot swaps, mock translator)
- `llm-config|prompts|context|client|gate.test.ts` — LLM toolkit (mock transport, no network)
- `llm-sdk-transports.test.ts` — official-SDK adapters (vi.mock'd `openai` / `@anthropic-ai/sdk`): error mapping, retry-after, pool block/disable, lazy load, cache skip
- `llm-context-limits.test.ts` — model context-limit table matching + `MT_CONTEXT_LIMITS` overrides
- `llm-stream.test.ts` — gate `stream: true` delta aggregation

The schema-doc tests stub `globalThis.fetch`, so they need neither a running router nor
`OPENROUTER_API_KEYS`; `translate-text.test.ts` is skipped unless that env var is set.

## Dependencies

`@mt/tools` depends on `@mt/core` for types and DSL builders. It does **not** depend on `@mt/waypoint` or `@mt/cli`.
