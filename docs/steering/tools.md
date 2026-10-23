# @mt/tools

Path: `packages/tools/`

Chapter processing tools for validation, translation, schema extraction, and formatting. All tools are `defineTool()` instances exported from `src/index.ts`. Tools operate on `Envelope<Chapter>` or domain-specific envelope types.

## Tool Catalogue

### `chapter-validator.ts`
- `chapterValidator` — structural markdown validation (heading hierarchy, code block languages, link integrity)
- `forbiddenCharDetector` — finds zero-width chars, forbidden control chars
- `typoFinder` — detects common Chinese/English typos, mixed scripts

### `chapter-doc.ts`
Reads/writes chapter YAML-frontmatter documents (`.chapter-doc.yml`). Internal format for passing per-chapter metadata between tools. Exports: `readChapterDoc`, `writeChapterDoc`.

### `schema-doc.ts`
LLM-powered schema document generation. Runs multiple sub-tools in sequence via OpenRouter:
- `summaryTool` — chapter summary
- `entitiesTool` — named entity extraction
- `schemaTool` — structured schema generation
- `metadataTool` — metadata extraction
- `vocabularyTool` — vocabulary/terminology
- `schemaDocWriter` — persists to `schema-doc://` target

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

## Key Patterns

**Tool signature:**
```typescript
export const myTool = defineTool<Input, Output>({
  name: 'my-tool',
  version: '1.0.0',
  async invoke(env, ctx) {
    // transform env.item
    return { ...env, item: result }
  },
})
```

**OpenRouter pool** (`openrouter-pool.ts`):
- Round-robin across `OPENROUTER_API_KEYS` (comma-separated env var)
- 429 → marks key exhausted until TTL
- 402 → removes key permanently
- Pool recreates on TTL expiry

## Tests

Tests live in `packages/tools/tests/`:
- `chapter-doc.test.ts` — unit tests for doc read/write
- `schema-doc.test.ts` — schema doc generation tests
- `md-formatter.test.ts` — formatter output tests
- `translate-text.test.ts` — translation tests (requires `OPENROUTER_API_KEYS`)

LLM-dependent tests are skipped unless the env var is set.

## Dependencies

`@mt/tools` depends on `@mt/core` for types and DSL builders. It does **not** depend on `@mt/waypoint` or `@mt/cli`.
