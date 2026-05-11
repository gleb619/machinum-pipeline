# Sample 2 — JSONL to MD Multi-Tool Pipeline

This sample demonstrates a rich pipeline composition that reads book chapters from JSONL, transforms them with multiple tool calls (word counting, chapter indexing), batches items, and writes the result to a Markdown file.

## What you will learn

- How to use the **simplified DSL syntax** with string URIs directly in `.from()` and `.to()` — no `source()`/`target()` wrappers needed.
- How to define custom tools with `defineTool()` and chain them with `.use()`.
- How to use `.flatMap()` to unwrap envelope items and transform content.
- How to use `.tap()` for side-effect logging during pipeline execution.
- How to use `.batch()` to group items before writing to the target.
- How to compose multiple tools (word-counter, chapter-indexer) in a single pipeline.

## Directory layout

```
samples/sample2/
├── pipelines/jsonl-to-md-multi.ts   # Pipeline definition (multi-tool, simplified syntax)
├── prepare-input.ts                 # Script to read books/book1 chapters and create JSONL input
├── mt.json                          # Project configuration
├── vitest.config.ts                 # Vitest configuration
├── jsonl/                           # Created at runtime — holds input.jsonl
│   └── .gitkeep
├── md/                              # Created at runtime — holds output.md
├── tests/
│   └── jsonl-to-md-multi.test.ts    # Integration test
└── vendor/                          # Created at runtime — local tarballs
```

## Pipeline flow

```
jsonl://./jsonl/input.jsonl
  → flatMap (unwrap envelope, produce markdown strings)
  → tap (log each item)
  → use(wordCounter)   ← counts words, adds wordCount to meta
  → use(chapterIndexer) ← extracts chapter number, adds chapterNum to meta
  → batch(3)           ← groups all 3 chapters
  → md://./md/output.md
```

## Simplified syntax vs full syntax

**Simplified (string URI)** — used in this sample:
```typescript
.from('jsonl://./jsonl/input.jsonl')
.to('md://./md/output.md')
```

**Full (wrapper instance)** — used in some older samples:
```typescript
.from(source('jsonl://./jsonl/input.jsonl'))
.to(target('md://./md/output.md'))
```

Both forms are equivalent — the registry resolves string URIs automatically.

## How to run

```bash
cd samples/sample2
npm run example
```

This packs local dependencies, installs them, prepares the JSONL input from `books/book1`,
and runs the multi-tool pipeline.

## How to clean up

```bash
cd samples/sample2
npm run cleanup
```

This removes `md/output.md`, `chapters/schema/*.schema.md`, `jsonl/input.jsonl`,
`.mt/`, `vendor/`, `node_modules/`, and `package-lock.json`.

## How to run manually

```bash
cd samples/sample2

# 1. Pack local dependencies
pnpm -C ../../packages/core pack --pack-destination ./vendor
pnpm -C ../../packages/cli pack --pack-destination ./vendor

# 2. Install them
npm install --no-audit --no-fund

# 3. Prepare the JSONL input from books/book1
pnpm run prepare-input

# 4. Run the pipeline
pnpm run runner

# 5. Check the output
cat md/output.md
```

## How the test works

The vitest test (`tests/jsonl-to-md-multi.test.ts`):

1. Creates a temporary directory with the pipeline definition, mt.json, and test data.
2. Packs and installs `@mt/core` and `@mt/cli` from the monorepo.
3. Writes a JSONL input file with 3 test chapters (simulating the prepare-input step).
4. Runs the pipeline via `mt run ./pipelines/jsonl-to-md-multi.ts`.
5. Verifies the output Markdown file contains all 3 chapter titles in the correct order.

## Tools

### word-counter
Counts the number of words in each markdown string and attaches `wordCount` to the envelope meta.

### chapter-indexer
Extracts the chapter number from markdown headings (e.g., `# Chapter 1: ...`) and attaches `chapterNum` to the envelope meta.
