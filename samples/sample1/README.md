# Sample 1 — HTTP to JSONL Pipeline

This sample demonstrates a complete end-to-end pipeline that ingests Markdown chapters over HTTP and writes them to a JSONL file.

## What you will learn

- How to define a pipeline using `@mt/core` DSL (`definePipeline`, `source`, `target`).
- How the HTTP source (`hs://`) receives documents and how the JSONL target (`jsonl://`) persists them.
- That the same `http://` scheme also works outbound: `.to('http://host:port/path')` sends each exchange as one HTTP request (see [waypoint steering](../../docs/steering/waypoint.md)).
- How a simulated client (Chrome-extension-style) reads `en.md` files from `books/book1` and POSTs them to the pipeline.
- How the integration test validates that the output file contains exactly the expected documents.

## Directory layout

```
samples/sample1/
├── pipelines/http-to-jsonl.ts   # Pipeline definition
├── simulation1.ts               # Client simulation (reads books/book1 chapter-*.en.md)
├── mt.json                      # Project configuration
├── jsonl/                       # Created at runtime — holds output.jsonl
└── chapters/                    # Created at runtime — holds .md output
```

## How to run

```bash
cd samples/sample1
npm run example
```

This starts the HTTP-to-JSONL pipeline runner, waits for the health endpoint,
runs the simulation client that POSTs 3 chapters, and waits for the runner to finish.

## How to clean up

```bash
cd samples/sample1
npm run cleanup
```

This removes `jsonl/output.jsonl`, `.mt/`, `node_modules/`, `package-lock.json`,
and any temporary `pipelines/http-to-jsonl-example.ts` created by the example.

## Stop / resume demo

`pipelines/stop-resume.ts` gates every item on its own latch file, so a run can be paused and
resumed deterministically instead of racing a slow source:

```ts
export default definePipeline({ id: 'sample1-stop-resume' })
  .from('range://1..5')
  .use(createWaitForFile({ path: './jsonl/latches/{item}.latch', pollMs: 100, timeoutMs: 600_000 }))
  .tap((env) => log.info('stop-resume item', { item: env.item }))
  .to('jsonl://./jsonl/stop-resume.jsonl')
```

`range://1..5` yields `1, 2, …, 5` and needs no fixtures. Each item waits for
`jsonl/latches/<n>.latch` to exist, then the JSONL target appends it to the run-scoped staging
file. Try it:

```bash
cd samples/sample1
mkdir -p jsonl/latches && touch jsonl/latches/1.latch
pnpm run runner:stop-resume        # blocks on item 2
# press Ctrl-C once item 1 is printed → run pauses, output so far survives
touch jsonl/latches/2.latch jsonl/latches/3.latch jsonl/latches/4.latch jsonl/latches/5.latch
pnpm exec mt resume <runId>        # runId is printed by the run and lives in .mt/runs/
cat jsonl/stop-resume.jsonl        # exactly 1..5, no duplicates
```

Why it is safe: the JSONL target flushes and fsyncs each envelope, and its `checkpoint()` reports
the number of envelopes it has taken. When you pause, the runner persists that count as the source
cursor (clamped to what the target committed). On resume the target truncates its staging file back
to that cursor — complete lines only — and appends from there, so an item written after the last
persist is replayed, never duplicated. Without a target checkpoint the cursor would stay at the
pre-run position and replay everything.

`pnpm cleanup` removes the output and the latch directory.

## How to run manually

```bash
cd samples/sample1

# 1. Start the pipeline runner in one terminal
pnpm run runner:http

# 2. In another terminal, send the chapters
pnpm run simulate

# 3. Check the output
cat jsonl/output.jsonl
```
