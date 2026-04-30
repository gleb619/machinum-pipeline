# Mt — Product Overview

**Mt** is a TypeScript library + CLI for building ETL-style pipelines that process long-form text (primarily books) through composable, checkpointable, partially-out-of-process tool chains. It is consumed as a dev dependency in another TS project — authors write pipelines as real `.ts` files using a thin DSL, declare project metadata in `mt.json`, and invoke the engine via the `mt` CLI. Mt produces artifacts (jsonl, md, pdf, epub) and persists run state under `.mt/`.

Key differentiators: pluggable Source/Tool/Target interfaces, per-step checkpoint tree for crash recovery, fork-join parallelism over chapters/paragraphs/lines, and an optional Nuxt-based admin server for live monitoring.

## Core Concepts

| Entity              | Role                                                                                                                                                           |
|---------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Source**          | Producer of Envelopes; can be `long-lived` (HTTP server) or `resumable` (file cursor). Addressed via URI (e.g. `jsonl://`, `http://`, `fs://`).                |
| **Tool**            | Pure function `Envelope<I> => Envelope<O>`; runs in-process or as a child process (`npx`/`deno`/`bun`). May be `cacheable` (content-hash memoisation).         |
| **Target**          | Sink that persists Envelopes; has open/write/close lifecycle (e.g. git commit on close). Addressed via URI.                                                    |
| **Pipeline**        | TS module exporting a DSL chain (`definePipeline().from().use().fork().to()`). Real code with real imports, no build step required.                            |
| **Run**             | One execution instance of a Pipeline, managed by a state machine: `pending -> running -> [checkpoint -> paused -> resumed ->] done/failed`. Fully resumable.   |
| **Checkpoint Tree** | Persisted execution graph — every step and fork tracked. On resume, engine walks tree depth-first, skips `done` nodes, continues from the first non-done node. |
| **Envelope**        | Transport unit: `{ item, items?, meta }`. Cardinality changes only via DSL ops (`.batch(n)`, `.window(n)`, `.flatMap()`).                                      |
| **`.mt/`**          | Per-project state directory. Contains runs, cache, logs, checkpoints — the file system is the source of truth.                                                 |
| **`mt.json`**       | Project configuration root — declares book metadata, pipeline paths, secrets env file, router URL, model defaults, retry/error/concurrency policies.           |

## Execution Flow

```
mt run ./pipelines/fix-typos.ts
→ CLI loads mt.json → builds GlobalContext
→ tsx/jiti loads pipeline module (no build step)
→ Engine mints runId, writes state.json (pending → running)
→ Source begins emitting Envelopes
→ Runner walks DSL ops, executing Tools in order
→ At each step boundary: append to events.jsonl, update checkpoint.json atomically
→ On .fork(subPipeline): child Runner registered as checkpoint subtree
→ On SIGINT/error per policy: running → checkpoint → paused/failed
→ On success: running → done, Targets close (e.g. git commit)
```

```
mt resume <runId>
→ Loads state.json, checkpoint.json, context.json
→ Walks checkpoint tree depth-first
→ Skips done nodes, resumes first non-done node
→ Calls source.resume(ctx, cursor) for resumable Sources, reconnects for long-lived
→ Continues execution
```

```
npx invocation of a Tool (out-of-process)
→ Runner serialises { envelope, toolContext } to JSON
→ Spawns npx <tool-name> (or deno/bun); writes JSON to stdin
→ Reads single JSON object (or NDJSON stream) from stdout
→ Validates output shape, emits downstream
```

## Services

| Service                   | Port               | Description                                                                                                                                       |
|---------------------------|--------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| CLI (`mt`)                | —                  | Binary entrypoint; orchestrates engine, loads pipelines, exposes `init`, `run`, `resume`, `ls runs`, `inspect`, `serve`, `router`, `mcp` commands |
| Backend (Nuxt/Nitro)      | Dynamic            | Serves admin UI, REST API for runs/pipelines, SSE stream tailing `events.jsonl`; optional SQLite for future search queries                        |
| Frontend (Vue + Tailwind) | Bundled in backend | Admin UI: runs list, run detail, pipelines registry, router dashboard link                                                                        |
| Router (standalone Nuxt)  | Configurable       | OpenAI-compatible proxy in front of OpenRouter with per-Run cost/usage tracking, rate limiting, retry, mock mode                                  |
| MCP Server                | stdio (no HTTP)    | Exposes `pipelines.list`, `pipelines.run`, `runs.list`, `runs.inspect`, `runs.pause`, `runs.resume`, `tools.invoke`, `book.read`, `chapter.read`  |

## Status

**Design / Draft — pre-implementation.** Milestones span M1 (engine spine, no UI) through M5 (extensions & polish). The architecture, domain model, execution semantics, and CLI surface are fully specified in `tdd.md`; all 54 use cases are documented in `uc.md`.
