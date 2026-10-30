# Sample 3 — Basic Markdown Processing

A minimal `mt` pipeline that shows the core mechanics without chapter-processing tools or LLM calls.

## What you will learn

- How to read a source (`jsonl://`, `range://`).
- How to emit a small event with a custom `defineTool` and `.tap`-style logging.
- How to use `.subflow()` to inline a reusable processing block and merge its output back into the parent stream.
- How to use `.fork()` to run child pipelines per envelope and merge their results back.
- How to write to a file target (`md://`, `jsonl://`) and how to discard output with `void://`.
- How to write to the built-in in-memory `ephemeral://` target.
- How to run a non-blocking side pipeline that reads the same source and counts/aggregates independently of the main flow.

## Pipeline file

`pipelines/basic-md-processing.ts` exports several pipelines:

| Pipeline | Command | Purpose |
|----------|---------|---------|
| `default` | `pnpm run runner` | JSONL → line → event → sync fork → async fork → `output.md` |
| `rangeDemoPipeline` | `pnpm run runner:range` | `range://1..3` → line → event → `void://` |
| `voidDemoPipeline` | `pnpm run runner:void` | Same JSONL source → line → event → `void://` |
| `ephemeralDemoPipeline` | `pnpm run runner:ephemeral` | JSONL → line → event → `ephemeral://basic-md-buffer` (in-memory) |
| `countSidePipeline` | `pnpm run runner:count` | JSONL → batch → count → write total to `counts.jsonl` (independent side branch) |

## Entity pipeline (`pipelines/entity-md-processing.ts`)

Shows how to move through the core entities `Chapter → Paragraph → Line → Word`:

```
jsonl/entities.jsonl
  → chapterDocBuild + chapterIndexer + chapterDocEmit   (JSONL → chapters-out/chapterN.md)
  → readChapterDoc                                     (md → ChapterDoc)
  → flatMap                                            (ChapterDoc → Paragraph entities)
  → ephemeral://sample3-paragraphs                     (in-process handoff)
  → flatMap                                            (Paragraph → Line entities)
  → ephemeral://sample3-lines                          (in-process handoff)
  → tokenizeWords                                      (Line → Word entities)
  → entities/words.jsonl
```

Key points:

- `@mt/tools` supplies the real builders/parsers: `chapterDocBuild`, `chapterDocEmit`,
  `chapterIndexer`, `readChapterDoc`, `tokenizeWords`. The sample only adds tiny `flatMap` glue.
- `ephemeral://` buffers are process-local, so the four stages run as `.subflow()`s inside one
  `mt run` (default pipeline is an orchestration-only pipeline).
- `defineWaypoint` wraps the ephemeral targets to log entity counts without changing payloads.
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
cd samples/sample3
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

- `output.md` contains every input line with both `[sync processed]` and `[async processed]` markers.
- `rangeDemoPipeline` emits one `line-seen` event per generated integer.
- `voidDemoPipeline` produces no `output.md` because `void://` discards everything.
- `ephemeralDemoPipeline` runs to completion using the built-in `ephemeral://` target.
- `countSidePipeline` logs the batch count and writes `counts.jsonl`.

`tests/entity-md-processing.test.ts` writes a two-chapter JSONL fixture and asserts:

- one markdown file per chapter under `chapters-out/`,
- the entity counts logged by the waypoint sinks (`paragraphs=4`, `lines=5`, `words=22`),
- one persisted `Word` envelope per JSONL line in `entities/words.jsonl`,
- `parallelBranchesPipeline` runs both forks per paragraph and the concurrency-probe windows overlap.
