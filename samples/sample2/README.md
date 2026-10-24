# Sample 2 — JSONL to MD Multi-Tool Pipeline

This sample reads book chapters from JSONL and processes them through several tool chains: verification,
schema-doc generation, and a stub translation. The default export is a pure orchestration pipeline — it has
no source or target of its own and runs ten named subflows on the same Runner.

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

## Directory layout

```
samples/sample2/
├── pipelines/jsonl-to-md-multi.ts   # Pipeline definition (subflow orchestration)
├── prepare-input.ts                 # Script to read books/book1 chapters and create JSONL input
├── mt.json                          # Project configuration
├── vitest.config.ts                 # Vitest configuration
├── jsonl/                           # Created at runtime — holds input.jsonl
│   └── .gitkeep
├── chapters/                        # Created at runtime — pipeline output
│   ├── en/                          #   verifyFlow: chapter1.md … chapterN.md
│   ├── ru/                          #   translateFlow: chapter1.md … chapterN.md ([ru] markers)
│   └── schema/                      #   schemaDocPipeline: chapterN.schema.md
└── tests/
    ├── jsonl-to-md-multi.test.ts    # Integration test (runs the real `mt` binary)
    └── chapter-processing.test.ts   # Unit tests over the tools used by the flows
```

## Pipeline flow

Default export — orchestration only, no `.from()`/`.to()` of its own:

```
default
  → subflow(verifyFlow)               → subflow(schemaDocPipeline)    → subflow(smokeTestPipeline)
  → subflow(splitChaptersPipeline)    → subflow(collectWarningsPipeline)  → subflow(countTokensFlow)
  → subflow(fixChapterPipeline)       → subflow(translateTitlesPipeline)
  → subflow(translateChapterPipeline) → subflow(translateFlow)
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
  → use(chapterIndexer)    ← meta.chapterNum
  → use(summaryTool)       ← meta.summary
  → use(entitiesTool)      ← meta.entities
  → use(schemaTool)        ← meta.schema
  → use(mdFormatter)       ← meta.mdFormatted / mdAlreadyFormatted
  → use(schemaDocWriter)   ← builds the schema doc, appends to meta.mdOutputs
  → md://./chapters        ← writes meta.mdOutputs → chapters/schema/chapter<N>.schema.md
```

### schemaDocMockPipeline — schemaDocWriter with a swapped emit slot

Same chain as `schemaDocPipeline`, but `.use(schemaDocWriter.with({ emit: mockSchemaEmit }))`: the `build`
slot (markdown assembly) is reused, the `emit` slot is replaced by a sample-local mock that tags the markdown
and redirects it to `chapters/schema-mock/chapter<N>.mock.md`. Run with `--pipeline schemaDocMockPipeline`.

### translateFlow — MD(EN) → MD(RU)

```
md://./chapters/en
  → use(wordCounter)
  → use(chapterIndexer)
  → use(stubTranslator)   ← local defineTool stub: wraps paragraphs in [ru]…[/ru], sets meta.translated + meta.lang='ru'
  → @ru (chapter-output://./chapters)  ← chapters/<lang>/chapter<N>.md → chapters/ru/chapter<N>.md
```

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
| `translateTitlesPipeline` | `batch(5)` → `titleTranslator` → `flatMap` |
| `translateChapterPipeline` | `flatMap` (split body on blank lines) → `paragraphTranslator` |

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

This removes `chapters/en/*.md`, `chapters/ru/*.md`, `chapters/schema/*.md`, `jsonl/input.jsonl`, and `.mt/`.

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

`tests/chapter-processing.test.ts` covers the tools directly (`chapterValidator`, `tokenSplitter`,
`forbiddenCharDetector`, `typoFinder`, `markdownFormatter`) by importing them from `packages/tools/src`,
without running the CLI.

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
Read the chapter document and attach `meta.summary`, `meta.entities`, and `meta.schema` (mermaid) respectively.

### mdFormatter
Reformats the markdown through the shared formatter, setting `meta.mdFormatted` and `meta.mdAlreadyFormatted`
(`meta.mdFormatError` on failure). Options come from `meta.mdFormatOptions`.

### schemaDocWriter
Assembles the schema document (frontmatter + Metadata table + Summary + Entities CSV) and appends it to
`meta.mdOutputs`, which the `md://` directory target writes to `chapters/schema/`. `wordCount`, `tokenCount`,
and `charLength` are read from meta, falling back to 0 and the item length.

### stubTranslator
Sample-local `defineTool()` stub: wraps each paragraph in `[ru]…[/ru]` and sets `meta.translated` plus
`meta.lang='ru'`, so the translation flow runs without any API call and lands in `chapters/ru/`.

### tokenSplitter / typoFinder / markdownFormatter / titleTranslator / paragraphTranslator
Used by the ephemeral flows to show splitting, typo detection, markdown formatting, and batched or
paragraph-level translation.
