# Sample 2 — Basic Markdown Processing

A minimal `mt` pipeline that shows the core mechanics without LLM calls — and without
hand-written tools: every step is a shipped waypoint or a package tool.

## What you will learn

- How to read a source (`jsonl://`, `range://`) and write a target (`md://`, `jsonl://`).
- How to fan data out with `.flatMap()` and group it with `.batch()`.
- How to hand data between stages through the entity buffers `lines://` and `words://`
  (in-process, no file in between).
- How to process the same stream in **sync**, **async** and **parallel** ways.
- How to branch the flow with `.fork()` and merge the branch results back.
- How to discard output with `void://` and how to keep it in memory with `ephemeral://`.
- How to run a non-blocking side pipeline that counts the corpus independently of the main flow.

## Pipeline file

`pipelines/basic-md-processing.ts` — **no `defineTool` in this file**. The only local code is
data glue inside `.flatMap()` and logging inside `.tap()`.

| Pipeline | Command | Purpose |
|----------|---------|---------|
| `default` | `pnpm run runner` | JSONL → `lines://` → `words://` → sync/async/parallel steps → two `.fork()` branches → `output.md` |
| `rangeDemoPipeline` | `pnpm run runner:range` | `range://1..3` → lines → word count → `void://` |
| `voidDemoPipeline` | `pnpm run runner:void` | Same JSONL source → lines → `void://` |
| `ephemeralDemoPipeline` | `pnpm run runner:ephemeral` | JSONL → lines → `ephemeral://basic-md-buffer` (in-memory) |
| `countSidePipeline` | `pnpm run runner:count` | JSONL → lines → batch → word statistics → `counts.jsonl` (independent side branch) |

### The default flow

```
jsonl://./jsonl/input.jsonl
  → flatMap              (record → one envelope per line)
  → lines://basic-md     (entity buffer — in-process handoff)
  → wordCounter          (package tool → `wordCount` variable)
  → flatMap              (line → words, via the package splitter `tokenizeWords`)
  → words://basic-md     (entity buffer)
  → tap (sync) / tap (async) / tokenCounter (parallel) / fork / fork
  → md://./output.md
```

The four stages are `.subflow()`s of an orchestration-only parent. A subflow that declares its
own `.from()` is **self-contained**: it runs after the upstream stream is consumed, in declaration
order. `lines://` and `words://` are process-local buffers, so the stage boundaries stay in memory.

### Sync, async, parallel, branching — what is really going on

| Step | Construct | Semantics |
|------|-----------|-----------|
| SYNC | `.tap(env => …)` | Observes each envelope, does not await. The stream moves on immediately. |
| ASYNC | `.tap(async env => { await … })` | The pipeline waits for the promise; the process does not block. |
| PARALLEL | `.use(tokenCounter)` | A tool step — the engine runs up to `defaults.concurrency` envelopes of that step at the same time (4 in `mt.json`), order preserved. |
| BRANCH | `.fork(child)` | A child pipeline per envelope, run one after another for that envelope. The child's output is merged back into the parent stream. |

`.fork()` is **per-envelope nesting, not parallelism** — the two branches of this sample run
sequentially for every line. Real parallelism is the per-tool-step limiter
(`defaults.concurrency`), and `.tap()` / `.flatMap()` are always sequential.

## Entity pipeline (`pipelines/entity-md-processing.ts`)

Shows how to move through the core entities `Chapter → Paragraph → Line → Word`:

```
jsonl/entities.jsonl
  → chapterDocBuild + chapterIndexer + chapterDocEmit   (JSONL → chapters-out/chapterN.md)
  → readChapterDoc                                     (md → ChapterDoc)
  → flatMap                                            (ChapterDoc → Paragraph entities)
  → paragraphs://                                      (in-process handoff)
  → flatMap                                            (Paragraph → Line entities)
  → lines://                                           (in-process handoff)
  → tokenizeWords                                      (Line → Word entities)
  → entities/words.jsonl
```

Key points:

- `@mt/tools` supplies the real builders/parsers: `chapterDocBuild`, `chapterDocEmit`,
  `chapterIndexer`, `readChapterDoc`, `tokenizeWords`. The sample only adds tiny `flatMap` glue.
- `paragraphs://` and `lines://` are built-in entity-buffer shortcuts over the same process-local
  buffer as `ephemeral://`, with one key space per entity level (and optional namespaces such as
  `paragraphs://branches`). They are registered globally by `@mt/waypoint` and embedded in the `mt`
  binary/CLI — this pipeline only uses them, it does not define them. The four stages therefore run
  as `.subflow()`s inside one `mt run`.
- `defineWaypoint` wraps the entity-buffer targets to log counts without changing payloads.
- `Word` is not a core domain type; the sample declares a local `WordEntity`.

| Pipeline | Command | Purpose |
|----------|---------|---------|
| `default` | `pnpm run runner:entities` | Full four-stage entity flow |
| `parallelBranchesPipeline` | `pnpm run runner:branches` | Two `.fork()` branches per paragraph + a concurrent probe step |

Branching facts the demo makes visible:

- `.fork()` is **per-envelope nesting, not parallelism** — `syncBranch` then `asyncBranch` run
  one after another for each paragraph.
- Real parallelism is the engine's per-tool-step concurrency (`defaults.concurrency` = 4 in
  `mt.json`). `parallelBranchesPipeline` logs `start`/`end` timestamps from `concurrencyProbe`;
  the test asserts the windows overlap.

```bash
pnpm run prepare-input      # writes jsonl/input.jsonl + jsonl/entities.jsonl
pnpm run runner:entities    # chapters-out/*.md + entities/words.jsonl
pnpm run runner:branches    # branch/parallel logs only
```


## Run manually

```bash
cd samples/sample2
pnpm run prepare-input
pnpm run runner
cat output.md
```

Try the non-blocking counter branch:

```bash
pnpm run runner:count    # writes counts.jsonl
```

## Clean up

```bash
pnpm run cleanup
```

## How the test works

The integration test writes fixed three-line JSONL input, runs each pipeline, and asserts:

- `output.md` contains every input line.
- the default pipeline logs one `sync` and one `async` event per line,
- both `.fork()` branches are merged back (`tokenCount` from the parallel tool step,
  `statWords` from the stats branch appear on the same envelope),
- the side stage counts the corpus (`totalWords=18`, `uniqueWords=10`).
- `rangeDemoPipeline` processes every generated number.
- `voidDemoPipeline` produces no `output.md` because `void://` discards everything.
- `ephemeralDemoPipeline` runs to completion using the built-in `ephemeral://` target.
- `countSidePipeline` logs the corpus totals and writes `counts.jsonl`.

`tests/entity-md-processing.test.ts` writes a two-chapter JSONL fixture and asserts:

- one markdown file per chapter under `chapters-out/`,
- the entity counts logged by the waypoint sinks (`paragraphs=4`, `lines=5`, `words=22`),
- one persisted `Word` envelope per JSONL line in `entities/words.jsonl`,
- `parallelBranchesPipeline` runs both forks per paragraph and the concurrency-probe windows overlap.
