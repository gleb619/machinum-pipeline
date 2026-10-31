# Sample 3 — JSONL to MD Multi-Tool Pipeline

This sample reads book chapters from JSONL and processes them through several tool chains: verification,
schema-doc generation, and mocked-LLM title/paragraph translation. The default export is a pure
orchestration pipeline — it has no source or target of its own and runs four subflows on the same
Runner. One extra named pipeline (`schemaDocMockPipeline`, a minimal slot-override demo) is run on
demand with `--pipeline <name>`.

## What you will learn

- How to use the **simplified DSL syntax** with string URIs directly in `.from()` and `.to()` — no
  `source()`/`target()` wrappers needed.
- How to compose subflows into a default pipeline with `.subflow()`.
- How to use `.flatMap()` to fan one envelope out into many (paragraph-level translation).
- How to use `.batch(n)` to group items before a tool, then `.flatMap()` to unwrap them again.
- How to use `.tap()` for side-effect logging, reading the variables the tools actually write
  (`chapterValidator` sets the `errors` variable, not `warnings`).
- How to write source/target URIs as `'@name'` shortcuts, resolved from `mt.json` → `"uris"`
  (`en` → `md://./chapters/en`, `ru` → `chapter-output://./chapters`), so the pipeline writes
  `.to('@en')` instead of the full URI.
- How to swap the LLM backend (and the model) of every LLM-backed tool with one env var.
- How to override one slot of a composable tool with `.with({ ... })` (`schemaDocMockPipeline`).

## LLM backend — one config point

Every LLM-backed tool of this sample (the schema-doc summary / entities / schema extractors and the
chapter title / paragraph translators) is wired to one pick, made once at the top of
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
samples/sample3/
├── pipelines/jsonl-to-md-multi.ts   # Pipeline definition (subflow orchestration)
├── prepare-input.ts                 # Script to read books/book1 chapters and create JSONL input
├── mt.json                          # Project configuration
├── vitest.config.ts                 # Vitest configuration
├── jsonl/                           # Created at runtime — holds input.jsonl
│   └── .gitkeep
├── chapters/                        # Created at runtime — pipeline output
│   ├── en/                          #   verifyFlow: chapter1.md … chapterN.md
│   ├── schema/                      #   schemaDocPipeline: chapterN.schema.md
│   └── schema-mock/                 #   schemaDocMockPipeline: chapterN.mock.md (slot-override demo)
└── tests/
    ├── jsonl-to-md-multi.test.ts    # Integration test (runs the real `mt` binary)
    ├── chapter-processing.test.ts   # Unit tests over the tools used by the flows
```

## Pipeline flow

Default export — orchestration only, no `.from()`/`.to()` of its own:

```
default
  → subflow(verifyFlow) → subflow(schemaDocPipeline)
  → subflow(translateTitlesPipeline) → subflow(translateChapterPipeline)
```

### verifyFlow — JSONL → verified MD

```
jsonl://./jsonl/input.jsonl
  → use(chapterDoc)             ← {title, body} record → chapter markdown; chapterDoc variable
  → use(wordCounter)            ← wordCount variable
  → use(chapterIndexer)         ← meta.chapterNum
  → use(chapterValidator)       ← valid variable + errors variable
  → use(forbiddenCharDetector)  ← forbidden variable
  → tap (log errors variable)
  → @en (md://./chapters/en)    ← directory target → chapters/en/chapter<N>.md
```

### schemaDocPipeline — JSONL → schema docs

```
jsonl://./jsonl/input.jsonl
  → use(toMarkdown)        ← native tool from packages/tools/src/to-markdown.ts (remark mdast → markdown)
  → use(wordCounter)       ← wordCount variable (feeds the schema doc Metadata table)
  → use(tokenCounter)      ← tokenCount variable (feeds the schema doc Metadata table)
  → use(chapterIndexer)    ← meta.chapterNum
  → use(summary)           ← summary variable        (picked LLM backend, see "LLM backend")
  → use(entities)          ← entities variable      (picked LLM backend)
  → use(schema)            ← schema variable        (picked LLM backend)
  → use(mdFormatter)       ← mdFormatted variable / mdAlreadyFormatted
  → use(schemaDocWriter)   ← builds the schema doc, appends a write intent (subdir 'schema') to mdOutputs variable
  → md://./chapters        ← target root; writes <root>/schema/chapter<N>.schema.md
```

### schemaDocMockPipeline — schemaDocWriter with a swapped emit slot

Same chain as `schemaDocPipeline`, but `.use(schemaDocWriter.with({ emit: stubSchemaEmit }))`: the `build`
slot (markdown assembly) is reused, the `emit` slot is replaced by a stub that tags the markdown and
redirects it to the target root's `schema-mock/` subfolder (`chapters/schema-mock/chapter<N>.mock.md`).
This is the one slot-override (`.with({ ... })`) example of the sample.
Run with `--pipeline schemaDocMockPipeline`.

### translateTitlesPipeline / translateChapterPipeline — mock-LLM translation (no disk I/O)

These two use `ephemeral://` sources/targets — they carry no items at runtime and exist to show the
DSL grammar and the mock-LLM translation path:

```
translateTitlesPipeline:   ephemeral://titles-input
    → batch(5) → use(titles)      ← title translator on the picked backend (mock by default)
    → flatMap (unwrap the batch)  → ephemeral://titles-output

translateChapterPipeline:  ephemeral://translate-input
    → flatMap (split body on blank lines)
    → use(paragraphs)             ← paragraph translator on the picked backend
    → ephemeral://translate-output
```

Both translators are built as `createTitleTranslator({ translate: llm.translate })` /
`createParagraphTranslator({ translate: llm.translate })`, so `MT_LLM_TOOL=ollama` runs the very
same flows against the GPU server (see "LLM backend" above).

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
cd samples/sample3
npm run example
```

This prepares the JSONL input from `books/book1` and runs the default orchestration pipeline (all subflows).

## How to clean up

```bash
cd samples/sample3
npm run cleanup
```

This removes `chapters/en/*.md`, `chapters/schema/*.md`, `chapters/schema-mock/*.md`,
`jsonl/input.jsonl`, and `.mt/`.

## How to run manually

```bash
cd samples/sample3

# 1. Prepare the JSONL input from books/book1
pnpm run prepare-input

# 2. Run the whole orchestration
pnpm run runner

# 2b. Or run one exported subflow
NODE_OPTIONS='--import tsx' mt run ./pipelines/jsonl-to-md-multi.ts --pipeline schemaDocPipeline

# 3. Check the output
ls chapters/en chapters/schema
head chapters/en/chapter1.md
head chapters/schema/chapter1.schema.md
```

## How the test works

The integration test (`tests/jsonl-to-md-multi.test.ts`):

1. Writes a JSONL input file with 3 test chapters (simulating the prepare-input step).
2. Runs the default pipeline via `mt run ./pipelines/jsonl-to-md-multi.ts` and checks that
   `chapters/en/chapter<N>.md` holds the right title and body, in order.
3. Runs `mt run … --pipeline schemaDocPipeline` and checks that `chapters/schema/chapter<N>.schema.md`
   is generated per chapter, with YAML frontmatter plus the Metadata, Summary, and Entities sections.
4. Runs `--pipeline schemaDocMockPipeline` and checks output lands only in `chapters/schema-mock/` (slot override).

`tests/chapter-processing.test.ts` covers the tools directly (`chapterValidator`, `tokenSplitter`,
`forbiddenCharDetector`, `typoFinder`, `markdownFormatter`) by importing them from `packages/tools/src`,
without running the CLI.

`pickLlmTool` / `readLlmConfig` come from `@mt/tools` (`packages/tools/tests/llm-picker.test.ts` covers the LLM config point): the default is the offline `mock` backend,
`MT_LLM_TOOL` / `MT_LLM_MODEL` select the backend and the model, `mt.json` `settings.llm.*` is the
file-based fallback, an unknown backend fails fast, and the picked backend answers without network.

## Tools

### chapterDoc
Turns a `{ title, body }` record into a chapter markdown document (frontmatter + H1 + body) and keeps the
parsed document in `chapterDoc` variable.

### wordCounter
Counts the words in a chapter (whitespace split) and sets the `wordCount` variable.

### chapterIndexer
Extracts the chapter number from markdown headings (e.g., `# Chapter 1: ...`) and stores `chapterNum` in `meta`.

### chapterValidator
Validates chapter markdown (H1 present, no heading-level skips, code blocks tagged, no broken links) and
sets the `valid` and `errors` variables.

### forbiddenCharDetector
Scans for zero-width and forbidden control characters and sets the `forbidden` variable.

### toMarkdown
Native `@mt/tools` builder (`packages/tools/src/to-markdown.ts`): renders a `{ title, body }` record into
markdown through a remark mdast, and sets the `toMarkdown` variable to `true`.

### summaryTool / entitiesTool / schemaTool
LLM-backed extractors (`packages/tools/src/schema/`). Each sends the chapter to the LLM and sets the
`summary`, `entities` and `schema` (mermaid) variables respectively. Every answer goes through a retry
loop guard: the response must be non-empty, mdshape-parseable, and keep the section content intact
(summary covers the chapter's key terms, entities/vocabulary actually occur in the text, the diagram has a
type declaration and edges). A rejected answer is re-prompted with the rejection reason, up to 3 attempts.
When the guard is exhausted — or no backend answers — the tool falls back to the deterministic value already
present in the chapter document, so the sample still produces `chapters/schema/chapter<N>.schema.md` without
credentials. Attempt count and last failure land in the `summaryLlm` / `entitiesLlm` / `schemaLlm` variables.
Prompts, model, temperature and `maxTokens` are set per tool via `create*Tool({ ... })` or per envelope via
the `schemaDocLlm` and `<tool>Prompt` variables.

In this sample the three extractors are built with the picked backend instead of the router proxy:
`createSummaryTool({ model: llm.model, call: llm.schemaCall })` — `call` replaces the router request with
the picked backend (mock by default, `ollama` / `openrouter-free` / … on demand). Without `call` they use
the OpenRouter proxy (`ctx.run.global.routerUrl`, default `http://localhost:7777`, also honouring
`MT_ROUTER_URL`) and the default model `openai/gpt-4o-mini`.

### mdFormatter
Reformats the markdown through the shared formatter, setting the `mdFormatted` and `mdAlreadyFormatted` variables
(`mdFormatError` on failure). Options come from the `mdFormatOptions` variable.

### schemaDocWriter
Assembles the schema document (frontmatter + Metadata table + Summary + Entities CSV) and appends it to
the `mdOutputs` variable as a write intent (`subdir: 'schema'`); the `md://` directory target resolves it under
its own root, i.e. `chapters/schema/` for the sample's `md://./chapters` target. `wordCount`, `tokenCount`,
and `charLength` are read from variables, falling back to 0 and the item length.

### titleTranslator / paragraphTranslator
Composable chapter translators used by the translation flows: `createTitleTranslator({ translate: llm.translate })`
and `createParagraphTranslator({ translate: llm.translate })` wire their `translate` slot to the picked
backend (mock by default). `titleTranslator` runs `extract -> translate -> assemble` (title from
frontmatter, H1, or first line); `paragraphTranslator` runs `split -> translate -> assemble` per paragraph.
