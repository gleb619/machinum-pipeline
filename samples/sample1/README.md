# Sample 1 — HTTP to JSONL Pipeline

This sample demonstrates a complete end-to-end pipeline that ingests Markdown chapters over HTTP and writes them to a JSONL file.

## What you will learn

- How to define a pipeline using `@mt/core` DSL (`definePipeline`, `source`, `target`).
- How the HTTP source (`hs://`) receives documents and how the JSONL target (`jsonl://`) persists them.
- How a simulated client (Chrome-extension-style) reads `en.md` files from `books/book1` and POSTs them to the pipeline.
- How the integration test validates that the output file contains exactly the expected documents.

## Directory layout

```
samples/sample1/
├── pipelines/http-to-jsonl.ts   # Pipeline definition
├── simulation1.ts               # Client simulation (reads books/book1 chapter-*.en.md)
├── mt.json                      # Project configuration
├── jsonl/                       # Created at runtime — holds output.jsonl
└── vendor/                      # Created at runtime — local tarballs
```

## How to run

```bash
cd samples/sample1
npm run example
```

This packs local dependencies, installs them, starts the HTTP-to-JSONL pipeline runner,
waits for the health endpoint, runs the simulation client that POSTs 3 chapters,
and waits for the runner to finish.

## How to clean up

```bash
cd samples/sample1
npm run cleanup
```

This removes `jsonl/output.jsonl`, `.mt/`, `vendor/`, `node_modules/`, `package-lock.json`,
and any temporary `pipelines/http-to-jsonl-example.ts` created by the example.

## How to run manually (no cleanup)

If you want to run the sample manually and inspect artifacts:

```bash
cd samples/sample1

# 1. Pack local dependencies
pnpm -C ../../packages/core pack --pack-destination ./vendor
pnpm -C ../../packages/cli pack --pack-destination ./vendor

# 2. Install them
npm install --no-audit --no-fund

# 3. Start the pipeline runner in one terminal
pnpm run runner

# 4. In another terminal, send the chapters
pnpm run simulate

# 5. Check the output
cat jsonl/output.jsonl
```
