# Product Overview

← [Architecture](../architecture.md)

**machinum-pipeline** (`mt`) is a TypeScript ETL engine for processing long-form text — primarily books — through composable, checkpointable tool chains.

Consumers write pipelines as real `.ts` files using a thin DSL, declare project metadata in `mt.json`, and invoke the engine via the `mt` CLI. Mt persists all run state under `.mt/` and produces artifacts (jsonl, md, schema-docs, translations).

## What it is not

- Not a general-purpose workflow engine (it is book/chapter-centric)
- Not a cloud service (fully local; the LLM router is an optional proxy)
- Not yet published to npm (pre-release, active development)

## Core Concepts

| Entity | Role |
|---|---|
| **Source** | Produces `Exchange<T>` items (`ExchangeInput`, normalized by the Runner); `resumable` (file cursor) or `long-lived` (HTTP). Addressed via URI. |
| **Tool** | Pure async function `Exchange<I> → Exchange<O>` (output derived from input); always in-process. |
| **Target** | Sink with `open/write/close` lifecycle (e.g. git commit on close). Addressed via URI. |
| **Pipeline** | TS module exporting a DSL chain. Real code — plain imports and logic work inside. |
| **Run** | One execution: `pending → running → [checkpoint → paused →] done / failed`. Fully resumable. |
| **Checkpoint tree** | Persisted execution graph. Resume = depth-first walk, skip `done` nodes, continue first non-done. |
| **Exchange** | `{ id, item: T, items?: T[], meta, variables }` (`variables` carry qualifiers `new/old/copy/alt`; `Envelope` is a deprecated alias). Cardinality changes only via DSL ops (`.batch`, `.flatMap`, `.window`). |
| **`.mt/`** | Per-project runtime state directory (runs, cache, events, dead-letter). Filesystem is source of truth. |
| **`mt.json`** | Project config: book metadata, pipeline paths, secrets env file, model defaults, retry/concurrency. |

## Domain Model

Books are structured as `Book → Chapter → Paragraph → Line`. All domain entities are plain interfaces. Sources provide stable IDs — the engine never mints domain entity IDs.

## Data Flow

```
Source (URI) → [Tool → Tool → …] → Target (URI)
```

All data travels in Exchanges. The pipeline DSL describes the shape; the Runner executes it.

## Services

| Service | Description |
|---|---|
| `mt` CLI | Binary entrypoint; `init`, `run`, `resume`, `ls runs`, `inspect`, `tool`, `serve`, `router`, `mcp` |
| Backend (h3; Nitro in dev) | Admin REST API + SSE event stream; serves bundled Vue frontend |
| Frontend (Vue 3) | Admin UI: runs list, detail, pipelines registry, router link |
| Router (standalone Nuxt) | OpenRouter proxy with key pool, cost tracking, rate limiting, mock mode |
| MCP server | stdio-only; wraps core/cli, no HTTP |
| Chrome extension | MV3; scrape chapters from tab, auto-upload to web editors |
| VS Code extension | `mt.json` schema, DSL hover, "Run pipeline" code lens |

## Execution Flow

```
mt run ./pipelines/fix-typos.ts
→ CLI loads mt.json → builds GlobalContext
→ tsx/jiti loads pipeline module (no build step)
→ Engine mints runId, writes state.json (pending → running)
→ Source begins emitting Exchanges
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
Tool invocation (in-process)
→ Runner calls tool.invoke(env, { run, step })
→ Tool returns an Exchange
→ Runner validates output shape, emits downstream
```

## Key Differentiators

- **Crash recovery**: checkpoint tree enables full resume from any failure point
- **Real pipeline files**: consumers write plain TypeScript, no config DSL lock-in
- **URI-addressed I/O**: sources and targets are pluggable via scheme registry (`jsonl://`, `md://`, `git://`, `hs://`, …)

---

## Milestones

| Milestone | Focus |
|---|---|
| M1 — Engine spine | `core` types/DSL, `jsonl` source/target, in-proc tools, file-based checkpoints, `cli`: `init`/`run`/`resume`/`inspect` |
| M2 — Forks & caching | `.fork()` with nested checkpoints, cache layer, git worktree source/target |
| M3 — Backend & frontend MVP | Nuxt backend, SSE event tail, runs list + detail + pipelines registry, `serve` in-process/detached, SQLite indicator |
| M4 — Router & integrations | Router Nuxt app, cost/usage tracking, mock mode, rolling logs; MCP server; long-lived HTTP source |
| M5 — Extensions & polish | VS Code extension, Chrome extension, VitePress docs site, frontend post-MVP screens |

---

## Open Questions / Deferred

- Schedules (`.mt/schedules/`): folder reserved; semantics deferred.
- Distributed runs across machines: out of scope.
- Hot-reload of running pipelines: out of scope.
- SQLite schema for backend search: deferred to post-MVP.
- Auth model for backend & router admin UIs: assumed localhost-only in v1; revisit before remote deploy.

---

## Glossary

- **Source** — Producer of exchanges; `long-lived` or `resumable`.
- **Tool** — Pure `Exchange<I> → Exchange<O>`; always in-process.
- **Target** — Sink with `open/write/close` lifecycle.
- **Pipeline** — Real `.ts` module exporting a DSL chain.
- **Run** — One resumable execution instance.
- **Checkpoint tree** — Persisted replay graph.
- **Exchange** — `{ id, item, items?, meta, variables }` transport unit.
- **`.mt/`** — Per-project filesystem source of truth.
- **`mt.json`** — Project configuration root.

← [Architecture Overview](../architecture.md)
