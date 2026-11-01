# Sample 2 — Basic Markdown Processing

Two `mt` pipelines over the same JSONL input, without LLM calls:

- **`pipelines/basic-md-processing.ts`** — the basics. One source, shipped tools, one target.
- **`pipelines/custom-md-processing.ts`** — the advanced version: a hand-composed pipeline with
  entity buffers, `.fork()` branches, a parallel step and a non-blocking side pipeline.

## What you will learn

- How to read a source (`jsonl://`, `range://`) and write a target (`md://`, `jsonl://`).
- How to use the tools that already ship in `@mt/tools` instead of hand-rolling your own.
- How to fan data out with `.flatMap()` and group it with `.batch()`.
- How to hand data between stages through the entity buffers `lines://` and `words://`
  (in-process, no file in between).
- How to process the same stream in **sync**, **async** and **parallel** ways.
- How to branch the flow with `.fork()` and merge the branch results back.
- How to discard output with `void://` and how to keep it in memory with `ephemeral://`.
- How to run a non-blocking side pipeline that counts the corpus independently of the main flow.
- How to clean a chapter of its decorative `---` lines, split it into token-bounded chunks and
  put the chunks back together — without re-splitting them on the next run.
- How to walk the **Structure Ladder** (`jsonl://` → `md://` → `chunks://` → `paragraphs://` →
  `lines://` → `words://`) and count every rung.

## Basics pipeline (`pipelines/basic-md-processing.ts`)

**No `defineTool` in this file** — every processing step is a tool that already ships in
`@mt/tools`. The whole pipeline body is three DSL calls:

```
jsonl://./jsonl/input.jsonl
  → flatMap              (record → one envelope per line)
  → wordCounter          (shipped tool → `wordCount` variable)
  → toMarkdownTool       (shipped tool → markdown text)
  → md://./chapters/output.md
```

| Pipeline | Command | Purpose |
|----------|---------|---------|
| `default` (implicit suite) | `pnpm run runner:basic` | No default export: implicit `basic-md-processing-suite` runs all three, alphabetical, sync |
| `defaultPipeline` | `pnpm run runner:basic -- --pipeline defaultPipeline` | JSONL → `wordCounter` → `toMarkdownTool` → `chapters/output.md` |
| `typedContentPipeline` | `pnpm run runner:basic -- --pipeline typedContentPipeline` | JSONL → typed `ChapterDoc` edit → `chapterDocBuild` → `output-typed.md` |
| `statsPipeline` | `pnpm run runner:stats` | JSONL → batch → `statFreq` (offline word-frequency report) → `void://` |

Commented examples at the end of the file show how to declare an explicit suite (order + mode) or make
one pipeline the default. Uncomment one to override the implicit suite.

Where the advanced pipeline writes its own glue, the basics pipeline reuses shipped tools:

| Advanced (`custom-md-processing.ts`) | Basics (`basic-md-processing.ts`) |
|-------------------------------------|-------------------------------------|
| local `toLinePayloads()` glue | `toMarkdownTool` (shipped) |
| local `sleep()` + `.tap()` counters | `wordCounter` (shipped) |
| local word-frequency aggregation | `statFreq` (shipped) |

## Advanced pipeline (`pipelines/custom-md-processing.ts`)

**One bespoke `defineTool`** (`toLinePayloads`) turns a JSONL record into prefixed lines — the
step the package does not ship. Everything else is a shipped waypoint or package tool.

| Pipeline | Command | Purpose |
|----------|---------|---------|
| `default` | `pnpm run runner:custom` | JSONL → `lines://` → `words://` → sync/async/parallel steps → two `.fork()` branches → `output.md` |
| `rangeDemoPipeline` | `pnpm run runner:range` | `range://1..3` → lines → word count → `void://` |
| `voidDemoPipeline` | `pnpm run runner:void` | Same JSONL source → lines → `void://` |
| `ephemeralDemoPipeline` | `pnpm run runner:ephemeral` | JSONL → lines → `ephemeral://basic-md-buffer` (in-memory) |
| `countSidePipeline` | `pnpm run runner:count` | JSONL → lines → batch → word statistics → `counts.jsonl` (independent side branch) |

### The advanced default flow

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

## Chunk normalization (`pipelines/chunk-normalization.ts`)

Two pipelines, both built from shipped pieces only — the package tools `chunkClean` /
`chunkSplit` / `splitIntoChunks` / `parseChunks` / `readChapterDoc` / `tokenizeWords` and the
built-in waypoints. The only local code is data glue inside `.flatMap()` and logging inside
`.tap()`.

| Pipeline | Command | Purpose |
|----------|---------|---------|
| `cleanSplitPipeline` (default) | `pnpm run runner:chunks` | Chapter → clean → token-bounded chunks → `out/chunked.md`, then the same file again → `out/chunked-reused.md` |
| `ladderPipeline` | `pnpm run runner:ladder` | The Structure Ladder → `out/ladder-chapters/*.md` + `out/ladder-summary.md` |

### Clean + split, and why the second run changes nothing

```
chapters/chapter1.md
  → md://./chapters/chapter1.md     (one envelope: the whole chapter)
  → chunkClean                       (drops the decorative `---` lines)
  → chunkSplit                       (cuts the text into token-bounded chunks,
                                      writes them back with `---` between them)
  → md://./out                       (out/chunked.md)
```

- **Chunk size.** `chunkSplit` resolves the target as `meta.chunkSize` → tool option →
  mt.json `settings.chunkSize` → `MT_CHUNK_SIZE` → 6000. The sample pins the tool option
  (`createChunkSplit({ chunkSize: CHUNK_SIZE })`, `CHUNK_SIZE = MT_CHUNK_SIZE ?? 40`) so one
  chapter always splits into several chunks; `MT_CHUNK_SIZE` still wins when it is set:
  `MT_CHUNK_SIZE=100 pnpm run runner:chunks`.
- **The chunk count** lands in `meta.chunkCount` and in the `chunkCount` variable, and in the
  output file. The `md://` target writes the payload verbatim — it has no frontmatter of its
  own — so the sample writes the count as a comment header (`<!-- chunkCount: 4 -->`) instead
  of a sidecar file. The header is stripped again before the next split, so it never counts as
  content.
- **Separator reuse.** Stage two reads `out/chunked.md` and runs the same splitter. The text
  already carries `---` separators, so the splitter keeps the chunks as they are instead of
  cutting them again — `out/chunked-reused.md` is byte-identical to `out/chunked.md`.

### The Structure Ladder

```
jsonl://./jsonl/ladder.jsonl      (a chapter record)
  → chapterDocBuild + chapterIndexer + chapterDocEmit   → md://./out/ladder-chapters
  → readChapterDoc + splitIntoChunks (md → chunks)      → chunks://ladder
  → split(/\n\n+/)                 (chunk → paragraphs) → paragraphs://ladder  (chunkId)
  → split('\n')                    (paragraph → lines)  → lines://ladder
  → tokenizeWords                  (line → words)       → words://ladder
  → batch + summary                                     → md://./out (out/ladder-summary.md)
```

Every step down the ladder is one `.flatMap()` (one envelope in, many out) plus one entity
buffer; the buffers are built in, the pipeline only uses them. The entities are the real core
types (`Chapter`, `Paragraph`, `Chunk`, `Line`); `Word` is not a core type, so the sample
declares one. The summary has one row per rung:

```
| Rung | Scheme | Units |
| --- | --- | --- |
| 0 | jsonl:// | 2 |
| 1 | md:// | 2 |
| 2 | chunks:// | 4 |
| 3 | paragraphs:// | 4 |
| 4 | lines:// | 5 |
| 5 | words:// | 73 |
```

#### Alternate route: chunks → tokens

`chunks://` also branches into `tokens://` (tiktoken-style BPE tokens, what the LLM sees).
`tokenLadderPipeline` runs jsonl → md → `chunks://` → `tokens://` → summary and writes
`out/token-ladder-summary.md` with the chunk count, the token count and a `Heuristic` flag
(true only when `gpt-tokenizer` is unavailable and ~4-char pieces are used). With the demo
fixture: 4 chunks, 86 tokens.

```bash
pnpm run runner:tokens    # out/token-ladder-summary.md
```

```bash
pnpm run prepare-input    # writes jsonl/ladder.jsonl too
pnpm run runner:chunks    # out/chunked.md + out/chunked-reused.md
pnpm run runner:ladder    # out/ladder-chapters/*.md + out/ladder-summary.md
```

## Run manually

```bash
cd samples/sample2
pnpm run prepare-input
pnpm run runner:basic    # implicit suite: all three basics pipelines
cat chapters/output.md
```

`mt run` builds an implicit suite when the file has no default export. Select one export with `--pipeline`:

```bash
pnpm run runner:basic -- --pipeline defaultPipeline
pnpm run runner:stats
```

The advanced pipeline:

```bash
pnpm run runner:custom   # entity buffers + forks + parallel step
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

`tests/basic-md-processing.test.ts` writes fixed three-line JSONL input, runs the basics
pipelines, and asserts:

- `chapters/output.md` contains every input line,
- the default pipeline logs the shipped `wordCounter` result per line (`wordCount=5`),
- `statsPipeline` logs the shipped `statFreq` report (`totalWords=15`, `uniqueWords=7`).

`tests/custom-md-processing.test.ts` writes the same fixture, runs the advanced pipelines, and asserts:

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

`tests/chunk-normalization.test.ts` runs the chunk pipelines and asserts:

- `out/chunked.md` holds the chapter as chunks separated by `---`,
- the chunk count in the exchange meta, in the file header and in the number of separators
  agree (`chunkCount - 1` separators, so no decorative line survived the clean step),
- the second run reuses the separators: `out/chunked-reused.md` is identical to
  `out/chunked.md` and both runs report the same chunk count,
- the ladder summary has one row per rung and the counts agree with the run log and with the
  fixture (2 records, 2 documents, more chunks than documents, at least one paragraph per chunk, 5 lines,
  73 words).
