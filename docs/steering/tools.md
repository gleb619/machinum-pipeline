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
- `translateText` — translates chapter content via OpenRouter. Config: `TranslateToolConfig` (model, sourceLanguage, targetLanguage, prompt template).

### `chapter-translator.ts`
Higher-level translation tool. Internally uses `translateText` and handles paragraph-level splitting via `token-splitter.ts`.

### `openrouter-tool.ts`
Low-level OpenRouter integration:
- `chatCompletion` — raw chat completion with streaming support
- `runPrompt` — simplified prompt runner

Uses the key pool from `openrouter-pool.ts` (round-robin, handles 429/402).

### `md-formatter.ts`
- `mdFormatterTool` — reformats markdown with configurable line width. Uses remark/unified under the hood.

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

The schema-doc tests stub `globalThis.fetch`, so they need neither a running router nor
`OPENROUTER_API_KEYS`; `translate-text.test.ts` is skipped unless that env var is set.

## Dependencies

`@mt/tools` depends on `@mt/core` for types and DSL builders. It does **not** depend on `@mt/waypoint` or `@mt/cli`.
