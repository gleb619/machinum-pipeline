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

The integration test writes a fixed three-line JSONL input, runs each pipeline, and asserts:

- `output.md` contains every input line with both `[sync processed]` and `[async processed]` markers.
- `rangeDemoPipeline` emits one `line-seen` event per generated integer.
- `voidDemoPipeline` produces no `output.md` because `void://` discards everything.
- `ephemeralDemoPipeline` runs to completion using the built-in `ephemeral://` target.
- `countSidePipeline` logs the batch count and writes `counts.jsonl`.
