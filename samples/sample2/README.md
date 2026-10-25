# Sample 2 — JSONL to MD Multi-Tool Pipeline

This sample reads book chapters from JSONL and processes them through several tool chains: verification,
schema-doc generation, and a stub translation. The default export is a pure orchestration pipeline — it has
no source or target of its own and runs ten named subflows on the same Runner. Extra named pipelines
(`schemaDocMockPipeline`, `llmGatePipeline`, `translateSlotsMockPipeline`) are run on demand with `--pipeline <name>`.

## What you will learn

- How to use the **simplified DSL syntax** with string URIs directly in `.from()` and `.to()` — no
  `source()`/`target()` wrappers needed.
- How to compose subflows into a default pipeline with `.subflow()`.
- How to define a custom in-memory tool with `defineTool()` and chain it with `.use()` (`stubTranslator`).
- How to use `.flatMap()` to fan one envelope out into many (paragraph-level translation).
- How to use `.batch(n)` to group items before a tool, then `.flatMap()` to unwrap them again.
- How to use `.tap()` for side-effect logging, reading the meta keys the tools actually write
  (`chapterValidator` sets `meta.errors`, not `meta.warnings`).
- How to write source/target URIs as `'@name'` shortcuts, resolved from `mt.json` → `"uris"`
  (`en` → `md://./chapters/en`, `ru` → `chapter-output://./chapters`), so the pipeline writes
  `.to('@en')` / `.to('@ru')` instead of the full URIs.
- How to swap the LLM backend (and the model) of every LLM-backed tool with one env var.

## LLM backend — one config point

Every LLM-backed tool of this sample (the schema-doc summary / entities / schema extractors, the
chapter translators, the LLM gate demo) is wired to one pick, made once at the top of
`pipelines/jsonl-to-md-multi.ts`:

```typescript
const llm = pickLlmTool()   // reads MT_LLM_TOOL / MT_LLM_MODEL
```

| `MT_LLM_TOOL` | Backend | Model default |
|---|---|---|
| `mock` (default) | offline scripted answer — no API key, no router | `mock` |
| `router` | MT router proxy (`MT_ROUTER_URL`, default `http://localhost:7777`) | `openai/gpt-4o-mini` |
| `openrouter-free` | OpenRouter free tier (`OPENROUTER_API_KEYS`) | `openrouter/free` |
| `openrouter-pool` | OpenRouter free models with sticky pinning | `openrouter/free` |
| `ollama` | ollama on the GPU server (`MT_OLLAMA_URL`, `MT_OLLAMA_MODEL`) | `gemma4:latest` |

`MT_LLM_MODEL` overrides the model of every backend; without it the backend default applies
(`MT_OLLAMA_MODEL` wins for `ollama`). The same two values can live in `mt.json` — the env vars
win over the file:

```json
"settings": {
  "llm.tool": "mock",
  "llm.model": ""
}
```

An unknown `MT_LLM_TOOL` fails fast with the list of valid backends. The default stays offline,
so the tests and `npm run example` need no credentials.

```bash
# offline (default)
pnpm run runner

# a real model on the GPU server
MT_LLM_TOOL=ollama MT_LLM_MODEL=qwen3:8b pnpm run runner
```

Nothing else changes: same pipeline, same tools — only the backend behind them.

## Directory layout

```
samples/sample2/
├── pipelines/jsonl-to-md-multi.ts   # Pipeline definition (subflow orchestration)
├── pipelines/llm-picker.ts          # LLM backend picker (MT_LLM_TOOL / MT_LLM_MODEL)
├── prepare-input.ts                 # Script to read books/book1 chapters and create JSONL input
├── mt.json                          # Project configuration
├── vitest.config.ts                 # Vitest configuration
├── jsonl/                           # Created at runtime — holds input.jsonl
│   └── .gitkeep
├── chapters/                        # Created at runtime — pipeline output
│   ├── en/                          #   verifyFlow: chapter1.md … chapterN.md
│   ├── ru/                          #   translateFlow: chapter1.md … chapterN.md ([ru] markers)
│   ├── schema/                      #   schemaDocPipeline: chapterN.schema.md
│   └── llm/                         #   llmGatePipeline: chapterN.llm.md
└── tests/
    ├── jsonl-to-md-multi.test.ts    # Integration test (runs the real `mt` binary)
    ├── chapter-processing.test.ts   # Unit tests over the tools used by the flows
    └── llm-picker.test.ts           # Unit tests over the LLM config point
```

## Pipeline flow

Default export — orchestration only, no `.from()`/`.to()` of its own:

```
default
  → subflow(verifyFlow)               → subflow(schemaDocPipeline)    → subflow(smokeTestPipeline)
  → subflow(splitChaptersPipeline)    → subflow(collectWarningsPipeline)  → subflow(countTokensFlow)
  → subflow(fixChapterPipeline)       → subflow(translateTitlesPipeline)
  → subflow(translateChapterPipeline) → subflow(translateFlow)
  → subflow(translateSlotsMockPipeline)
```

### verifyFlow — JSONL → verified MD

```
jsonl://./jsonl/input.jsonl
  → use(chapterDoc)             ← {title, body} record → chapter markdown; meta.chapterDoc
  → use(wordCounter)            ← meta.wordCount
  → use(chapterIndexer)         ← meta.chapterNum
  → use(chapterValidator)       ← meta.valid + meta.errors
  → use(forbiddenCharDetector)  ← meta.forbidden
  → tap (log meta.errors)
  → @en (md://./chapters/en)    ← directory target → chapters/en/chapter<N>.md
```

### schemaDocPipeline — JSONL → schema docs

```
jsonl://./jsonl/input.jsonl
  → use(toMarkdown)        ← native tool from packages/tools/src/to-markdown.ts (remark mdast → markdown)
  → use(wordCounter)       ← meta.wordCount (feeds the schema doc Metadata table)
  → use(tokenCounter)      ← meta.tokenCount (feeds the schema doc Metadata table)
  → use(chapterIndexer)    ← meta.chapterNum
  → use(summary)           ← meta.summary        (picked LLM backend, see "LLM backend")
  → use(entities)          ← meta.entities      (picked LLM backend)
  → use(schema)            ← meta.schema        (picked LLM backend)
  → use(mdFormatter)       ← meta.mdFormatted / mdAlreadyFormatted
  → use(schemaDocWriter)   ← builds the schema doc, appends a write intent (subdir 'schema') to meta.mdOutputs
  → md://./chapters        ← target root; writes <root>/schema/chapter<N>.schema.md
```

### schemaDocMockPipeline — schemaDocWriter with a swapped emit slot

Same chain as `schemaDocPipeline`, but `.use(schemaDocWriter.with({ emit: mockSchemaEmit }))`: the `build`
slot (markdown assembly) is reused, the `emit` slot is replaced by a sample-local mock that tags the markdown
and redirects it to the target root's `schema-mock/` subfolder (`chapters/schema-mock/chapter<N>.mock.md`).
Run with `--pipeline schemaDocMockPipeline`.

### llmGatePipeline — LLM gate with the picked `call` slot (offline by default)

Not part of the default subflow chain (it is a demo; it needs no API key). Shows the LLM toolkit:

```
jsonl://./jsonl/input.jsonl
  → use(toLlmGateInput)        ← record -> {title, body, history[6 earlier notes]}, meta.chapterNum
  → use(chapterSummaryGate)    ← createLlmGate(...).with({ call: llm.gate.slots.call })
        prepare: custom 'summary' prompt template (override of the built-in default)
        fit:     context budget maxTokens=60, strategies ['dropOldest','truncateLines']
        call:    the picked backend's call slot (mock by default: scripted answer, no network)
  → use(llmSummaryToMd)        ← markdown incl. `context: <before> -> <after> tokens` (meta.contextWindow)
  → use(mdOutputEmitter(...))  ← write intent (subdir 'llm') -> <root>/llm/chapter<N>.llm.md
  → md://./chapters
```

The `call` slot comes from the picked backend, so `MT_LLM_TOOL=ollama` runs the very same gate
against the GPU server (see "LLM backend" above). Override the prompt without code via
`MT_PROMPT_SUMMARY='...'` or `MT_PROMPT_SUMMARY=@prompts/summary.md`.

### translateFlow — MD(EN) → MD(RU)

```
md://./chapters/en
  → use(wordCounter)
  → use(chapterIndexer)
  → use(stubTranslator)   ← local defineTool stub: wraps paragraphs in [ru]…[/ru], sets meta.translated + meta.lang='ru'
  → @ru (chapter-output://./chapters)  ← chapters/<lang>/chapter<N>.md → chapters/ru/chapter<N>.md
```

### translateSlotsMockPipeline — chapter translators with a swapped `translate` slot (offline)

```
jsonl://./jsonl/input.jsonl
  → use(toChapterTranslateInput)                       ← record -> {text, targetLang:'ru'}, meta.chapterNum
  → use(titleTranslator.with({ translate: titleTranslateSlotMock }))
  → use(paragraphTranslator.with({ translate: paragraphTranslateSlotMock }))
        translate slot <- offline mock (wraps title/paragraphs in [mock]…[/mock]); no API key, no router
  → use(translateOutputToMd)
  → use(mdOutputEmitter(...))  ← write intent (subdir 'translate-mock') -> <root>/translate-mock/chapter<N>.mock.md
  → md://./chapters
```

The composable chapter translators (`extract/translate/assemble`, `split/translate/assemble`) keep every slot
except `translate`. To swap in another `Tool<TranslateInput, TranslateOutput>` without writing a state-level
slot, use `createTitleTranslator({ translate })` / `createParagraphTranslator({ translate })`.

### countTokensFlow — token counting demo (batched)

Unlike the ephemeral flows below, this one reads the JSONL source directly and writes to an
`ephemeral://` target (batch-level meta has no per-item file keying):

```
jsonl://./jsonl/input.jsonl
  → flatMap (fan out to title + body)
  → batch(5)
  → use(tokenCounterBatch)        ← meta.tokenCount (batch-level meta)
  → use(tokenCounterBatchCached)  ← cached variant
  → ephemeral://tokens-output
```

### Ephemeral flows — tool chains with no disk I/O

These exercise single tools through `ephemeral://` sources; they carry no items at runtime and exist to show
the DSL grammar.

| Export | Chain |
|---|---|
| `smokeTestPipeline` | `chapterValidator` → `tap` |
| `splitChaptersPipeline` | `tokenSplitter` |
| `collectWarningsPipeline` | `forbiddenCharDetector` → `tap` (logs `meta.forbidden`) |
| `fixChapterPipeline` | `typoFinder` → `markdownFormatter` |
| `translateTitlesPipeline` | `batch(5)` → `titles` (title translator on the picked backend) → `flatMap` |
| `translateChapterPipeline` | `flatMap` (split body on blank lines) → `paragraphs` (paragraph translator on the picked backend) |

## Simplified syntax vs full syntax

**Simplified (string URI)** — used in this sample:
```typescript
.from('jsonl://./jsonl/input.jsonl')
.to('md://./chapters/en')
```

**Full (wrapper instance)** — used in some older samples:
```typescript
.from(source('jsonl://./jsonl/input.jsonl'))
.to(target('md://./chapters/en'))
```

Both forms are equivalent — the registry resolves string URIs automatically.

## How to run

```bash
cd samples/sample2
npm run example
```

This prepares the JSONL input from `books/book1` and runs the default orchestration pipeline (all subflows).

## How to clean up

```bash
cd samples/sample2
npm run cleanup
```

This removes `chapters/en/*.md`, `chapters/ru/*.md`, `chapters/schema/*.md`, `chapters/llm/*.md`,
`chapters/translate-mock/*.md`, `jsonl/input.jsonl`, and `.mt/`.

## How to run manually

```bash
cd samples/sample2

# 1. Prepare the JSONL input from books/book1
pnpm run prepare-input

# 2. Run the whole orchestration
pnpm run runner

# 2b. Or run one exported subflow
NODE_OPTIONS='--import tsx' mt run ./pipelines/jsonl-to-md-multi.ts --pipeline schemaDocPipeline

# 3. Check the output
ls chapters/en chapters/ru chapters/schema
head chapters/en/chapter1.md
head chapters/schema/chapter1.schema.md
```

## How the test works

The integration test (`tests/jsonl-to-md-multi.test.ts`):

1. Writes a JSONL input file with 3 test chapters (simulating the prepare-input step).
2. Runs the default pipeline via `mt run ./pipelines/jsonl-to-md-multi.ts` and checks that
   `chapters/en/chapter<N>.md` holds the right title and body, in order, and that
   `chapters/ru/chapter<N>.md` holds the `[ru]…[/ru]` markers produced by `stubTranslator`.
3. Runs `mt run … --pipeline schemaDocPipeline` and checks that `chapters/schema/chapter<N>.schema.md`
   is generated per chapter, with YAML frontmatter plus the Metadata, Summary, and Entities sections.
4. Runs `--pipeline schemaDocMockPipeline` and checks output lands only in `chapters/schema-mock/` (slot override).
5. Runs `--pipeline llmGatePipeline` and checks `chapters/llm/chapter<N>.llm.md`: mock answer, custom prompt text, and that the context budget shrank the history (`context: A -> B tokens`, B <= 60).
6. Runs `--pipeline translateSlotsMockPipeline` and checks `chapters/translate-mock/chapter<N>.mock.md` holds the
   `[mock]…[/mock]` markers from the swapped `translate` slots (title + paragraphs, offline).

`tests/chapter-processing.test.ts` covers the tools directly (`chapterValidator`, `tokenSplitter`,
`forbiddenCharDetector`, `typoFinder`, `markdownFormatter`) by importing them from `packages/tools/src`,
without running the CLI.

`tests/llm-picker.test.ts` covers the LLM config point: the default is the offline `mock` backend,
`MT_LLM_TOOL` / `MT_LLM_MODEL` select the backend and the model, `mt.json` `settings.llm.*` is the
file-based fallback, an unknown backend fails fast, and the picked backend answers without network.

## Tools

### chapterDoc
Turns a `{ title, body }` record into a chapter markdown document (frontmatter + H1 + body) and keeps the
parsed document in `meta.chapterDoc`.

### wordCounter
Counts the words in a chapter (whitespace split) and attaches `wordCount` to meta.

### chapterIndexer
Extracts the chapter number from markdown headings (e.g., `# Chapter 1: ...`) and attaches `chapterNum` to meta.

### chapterValidator
Validates chapter markdown (H1 present, no heading-level skips, code blocks tagged, no broken links) and
attaches `valid` plus the `errors` list to meta.

### forbiddenCharDetector
Scans for zero-width and forbidden control characters and attaches the `forbidden` entries to meta.

### toMarkdown
Native `@mt/tools` builder (`packages/tools/src/to-markdown.ts`): renders a `{ title, body }` record into
markdown through a remark mdast, and sets `toMarkdown: true` in meta.

### summaryTool / entitiesTool / schemaTool
LLM-backed extractors (`packages/tools/src/schema/`). Each sends the chapter to the LLM and attaches
`meta.summary`, `meta.entities`, and `meta.schema` (mermaid) respectively. Every answer goes through a retry
loop guard: the response must be non-empty, mdshape-parseable, and keep the section content intact
(summary covers the chapter's key terms, entities/vocabulary actually occur in the text, the diagram has a
type declaration and edges). A rejected answer is re-prompted with the rejection reason, up to 3 attempts.
When the guard is exhausted — or no backend answers — the tool falls back to the deterministic value already
present in the chapter document, so the sample still produces `chapters/schema/chapter<N>.schema.md` without
credentials. Attempt count and last failure land in `meta.summaryLlm` / `entitiesLlm` / `schemaLlm`.
Prompts, model, temperature and `maxTokens` are set per tool via `create*Tool({ ... })` or per envelope via
`meta.schemaDocLlm` and `meta.<tool>Prompt`.

In this sample the three extractors are built with the picked backend instead of the router proxy:
`createSummaryTool({ model: llm.model, call: llm.schemaCall })` — `call` replaces the router request with
the picked backend (mock by default, `ollama` / `openrouter-free` / … on demand). Without `call` they use
the OpenRouter proxy (`ctx.run.global.routerUrl`, default `http://localhost:7777`, also honouring
`MT_ROUTER_URL`) and the default model `openai/gpt-4o-mini`.

### mdFormatter
Reformats the markdown through the shared formatter, setting `meta.mdFormatted` and `meta.mdAlreadyFormatted`
(`meta.mdFormatError` on failure). Options come from `meta.mdFormatOptions`.

### schemaDocWriter
Assembles the schema document (frontmatter + Metadata table + Summary + Entities CSV) and appends it to
`meta.mdOutputs` as a write intent (`subdir: 'schema'`); the `md://` directory target resolves it under
its own root, i.e. `chapters/schema/` for the sample's `md://./chapters` target. `wordCount`, `tokenCount`,
and `charLength` are read from meta, falling back to 0 and the item length.

### stubTranslator
Sample-local `defineTool()` stub: wraps each paragraph in `[ru]…[/ru]` and sets `meta.translated` plus
`meta.lang='ru'`, so the translation flow runs without any API call and lands in `chapters/ru/`.

### tokenSplitter / typoFinder / markdownFormatter / titleTranslator / paragraphTranslator
Used by the ephemeral flows to show splitting, typo detection, markdown formatting, and batched or
paragraph-level translation.
