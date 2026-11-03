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
  (`en` → `md://./chapters/en`, `ru` → `my-target://./chapters`), so the pipeline writes
  `.to('@en')` instead of the full URI.
- How to register a **sample-defined URI scheme** — `my-target://` is not a stock scheme, so
  `waypoints/my-target.ts` registers it with `registry.registerSource/registerTarget` at module
  load (imported by every pipeline that names it).
- How to swap the LLM backend (and the model) of every LLM-backed tool with one env var.
- How to install a process-wide mock LLM provider with `defineProcess().install(mockLlm(...))`
  so tools need no per-file wiring.
- How to override one slot of a composable tool with `.with({ ... })` (`schemaDocMockPipeline`).

## LLM backend — process-level mock install

Every LLM-backed tool of this sample (the schema-doc summary / entities / schema extractors and the
chapter title / paragraph translators) is built WITHOUT explicit wiring; the backend is resolved at
invoke time. The default export installs an offline mock provider process-wide at module load:

```typescript
export default defineProcess()
  .install(mockLlm({ source: (req) => `mock-answer: ${req.messages.at(-1)?.content}` }))
  .pipeline(definePipeline().subflow(...))
```

Resolution order: explicit factory argument (`createSummaryTool({ call })`) > `MT_LLM_TOOL` /
mt.json `settings.llm.tool` naming a real backend > the installed mock (when the pick is `mock`,
the default) > the factory default (router proxy). See [docs/mock-tools.md](../../docs/guiding/mock-tools.md).

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
so the tests and `npm run example` need no credentials. (`pickLlmTool` is still exported from
`@mt/tools` for pipelines that prefer explicit wiring — it is what the env-named real backends
are resolved through.)

```bash
# offline (default)
pnpm run runner:multi

# a real model on the GPU server
MT_LLM_TOOL=ollama MT_LLM_MODEL=qwen3:8b pnpm run runner:multi
```

Nothing else changes: same pipeline, same tools — only the backend behind them.

## Directory layout

```
samples/sample3/
├── pipelines/jsonl-to-md-multi.ts   # Pipeline definition (subflow orchestration)
├── pipelines/jsonl-to-md-simple.ts  # Plain pipeline: verifyFlow + stubTranslator translateFlow
├── waypoints/my-target.ts           # Sample-defined `my-target://` scheme registration
├── run-all.ts                       # Aggregate runner: launches every runner:<name> script
├── prepare-input.ts                 # Generates the lorem ipsum JSONL input
├── mt.json                          # Project configuration
├── vitest.config.ts                 # Vitest configuration
├── jsonl/                           # Created at runtime — holds input.jsonl
│   └── .gitkeep
├── chapters/                             # Created at runtime — runner-report.md
├── chapters/                        # Created at runtime — pipeline output
│   ├── en/                          #   verifyFlow: chapter1.md … chapterN.md
│   ├── ru/                          #   stubTranslator translateFlow (simple pipeline only)
│   ├── schema/                      #   schemaDocPipeline: chapterN.schema.md
│   └── schema-mock/                 #   schemaDocMockPipeline: chapterN.mock.md (slot-override demo)
└── tests/
    ├── jsonl-to-md-multi.test.ts    # Integration test (runs the real `mt` binary)
    ├── chapter-processing.test.ts   # Unit tests over the tools used by the flows
```

## Generated input fixture

`prepare-input.ts` generates `jsonl/input.jsonl` — three chapter records with lorem ipsum bodies
from the `lorem-ipsum` dev dependency and a seeded PRNG, so a forced regeneration produces the same
text. The titles are fixed (`Chapter 1: The Road from Thornhaven`, …) because the title dictionary
in `pipelines/jsonl-to-md-multi.ts` translates them by name. No `books/` directory is needed.

The file is written **once**. Running `pnpm run prepare-input` again keeps an existing file:

```bash
pnpm run prepare-input        # write the fixture if missing, keep an existing one
pnpm run prepare-input:force  # regenerate deterministically
```

## Pipeline flow

Default export — orchestration only, no `.from()`/`.to()` of its own:

```
default
  → subflow(verifyFlow) → subflow(schemaDocPipeline)
  → subflow(titlePacketPipeline)
  → subflow(translateTitlesPipeline) → subflow(translateChapterPipeline)
```

### jsonl-to-md-simple.ts — same verify flow, no orchestration

A second, plain pipeline file: two independent flows joined by a default `.subflow()` orchestration (same
grammar as above, but simpler — no LLM tools, no schema docs):

```
verifyFlow:     jsonl://./jsonl/input.jsonl
                  → chapterDoc → wordCounter → chapterIndexer → chapterValidator
                  → forbiddenCharDetector → tokenCounter → @en
translateFlow:  @en
                  → wordCounter → chapterIndexer → stubTranslator (placeholder, no LLM)
                  → @ru (my-target://./chapters → chapters/ru)
```

`@en` and `@ru` are the `mt.json` URI shortcuts. `@ru` points at the sample-defined
`my-target://` scheme (see `waypoints/my-target.ts`). Run it with `pnpm run runner:simple`.

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

### titlePacketPipeline — nested batch scope (packaged titles)

ONE pipeline replaces the old producer / translator / applier split plus `batches://` hop:

```
my-target:// (lang=en) → .batch(titleScope)         ← packages of 5 (default), scope runs per package
  scope: batch://group   → schemaTitles → dictionary translator → packet parser → batch://return
         batch://members → applyTranslatedTitle (per chapter)                   → batch://return
→ my-target://./chapters   (original chapters, patched: ru title + meta.lang=ru → chapters/ru/)
```

`batch://group` shows the package as one item; `batch://members` as N singles; `batch://return`
hands the result back and the outer stream continues with the original chapters.

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

Both translators resolve the process-level LLM pick at invoke time (installed mock by default),
so `MT_LLM_TOOL=ollama` runs the very same flows against the GPU server (see "LLM backend" above).

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

This prepares the lorem ipsum JSONL input (generated by `prepare-input.ts`, no external book files
needed) and runs every pipeline of the sample through `npm run runner`. The runner also writes a
markdown report of the sweep to `chapters/runner-report.md` (see below).

For only the multi-tool orchestration pipeline:

```bash
cd samples/sample3
npm run example:multi
```

For only the simple pipeline (verify + placeholder translation, no schema docs):

```bash
cd samples/sample3
npm run example:simple
```

### Aggregate runner

```bash
pnpm run runner          # every runner:<name> script, one by one
cat chapters/runner-report.md # markdown report of the whole sweep
```

`pnpm run runner` runs `run-all.ts`: it prepares missing fixtures, then launches every
`runner:<name>` script one after another and writes a markdown report to `chapters/runner-report.md` —
one row per runner with its status, duration, run id, the files it touched and the captured output.
The same text goes to stdout, so `pnpm run runner | less` works too. Discovery is dynamic: a new
`runner:<name>` script that calls `mt run …` is picked up without touching `run-all.ts`.

The runner scripts stay individually runnable:

```bash
pnpm run runner:multi   # → chapters/en, chapters/ru, chapters/schema
pnpm run runner:simple  # → chapters/en, chapters/ru
```

## How to clean up

```bash
cd samples/sample3
npm run cleanup
```

This removes `chapters/runner-report.md`, `chapters/en/*.md`, `chapters/ru/*.md`, `chapters/schema/*.md`,
`chapters/schema-mock/*.md`, `jsonl/input.jsonl`, and `.mt/`.

## Inspect without running

`mt explain` loads the pipeline module but starts no source, tool, target or lifecycle hook, so it
never creates `.mt/runs/<runId>/`:

```bash
cd samples/sample3
pnpm run explain        # Markdown: flow, effective policies, events, log/artifact paths
pnpm run explain:json   # same as one JSON document on stdout
NODE_OPTIONS='--import tsx' mt explain ./pipelines/jsonl-to-md-multi.ts --pipeline schemaDocPipeline
```

The Markdown form shows the dataflow, effective retry/onError/concurrency policies, events,
checkpoint nodes and log/artifact paths. `--pipeline <name>` explains a named export instead of the
default; `--json` prints exactly one parseable document on stdout (import-time logs go to stderr).

## How to run manually

```bash
cd samples/sample3

# 1. Prepare the lorem ipsum JSONL input (write-once; --force regenerates)
pnpm run prepare-input

# 2. Run every pipeline of the sample (writes chapters/runner-report.md)
pnpm run runner

# 2a. Or run only the multi-tool orchestration pipeline
pnpm run runner:multi

# 2b. Or run one exported subflow
NODE_OPTIONS='--import tsx' mt run ./pipelines/jsonl-to-md-multi.ts --pipeline schemaDocPipeline

# 2c. Or run the simple pipeline (verify + stub translation)
pnpm run runner:simple

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
The process-level install (`mockLlm` / `resolveProcessLlm` / invoke-time factory fallback) is covered
by `packages/tools/tests/llm-install.test.ts`.

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

In this sample the three extractors are built without explicit wiring (`createSummaryTool()` …):
at invoke time they resolve the process-level pick — the installed mock by default, or the real
backend when `MT_LLM_TOOL` names one (see "LLM backend"). An explicit
`createSummaryTool({ model, call })` still wins when given; without any of the above they use
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
Composable chapter translators used by the translation flows: built here as `createTitleTranslator()` /
`createParagraphTranslator()` with no `translate` option — the `translate` slot resolves the
process-level pick at invoke time (installed mock by default; `MT_LLM_TOOL=ollama` runs the same
flows against the GPU server). An explicit `{ translate }` still wins. `titleTranslator` runs
`extract -> translate -> assemble` (title from frontmatter, H1, or first line); `paragraphTranslator`
runs `split -> translate -> assemble` per paragraph.
