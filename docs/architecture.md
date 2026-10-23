# Architecture — High-Level Overview

> **Scope:** Vision, data flow, module map, and pointers to deep detail.
> **Status:** Draft v1 · **Full spec:** `docs/tdd.md` · **Module detail:** `docs/steering/*.md`

← [Steering Index](#details-index) · [Back to docs/steering/](steering/)

---

## 1. Vision & Goals

**MT** (`machinum-pipeline`, package `@mt/core`) is a TypeScript ETL engine for long-form text (primarily books). It runs as a dev dependency in a consumer project: the user writes real `.ts` pipeline modules using a thin DSL, declares metadata in `mt.json`, and executes via the `mt` CLI. The engine produces artifacts (`jsonl`, `md`, `pdf`, `epub`) and persists all run state under `.mt/`.

Primary goals:
- **Pluggable** — Sources, Tools, Targets are interfaces; tools can run in-process or as short-lived `npx`/`deno`/`bun` child processes.
- **Resumable** — Per-Run state machine with checkpoint tree; crash recovery to the last completed step.
- **Parallel by design** — Fork-join over Chapters/Paragraphs/Lines; batching and windowing built in.
- **Hybrid runtime** — CLI (foreground or detached) or Nuxt-based admin server (`backend`).
- **Git-aware (opt-in)** — Source/Target wrap worktree creation/removal so processing never touches master.
- **Observable** — File-based event log (`events.jsonl`) is the source of truth; backend tails it and streams via SSE.

Non-goals (v1): distributed execution across machines, hot-reloading while a Run is in flight, built-in scheduling daemon (folder reserved in `.mt/schedules/`).

For full product overview (what it is / is not, core concepts, services), see [`docs/steering/product.md`](steering/product.md).

---

## 2. Data Flow

```
Source (URI) → [Tool → Tool → …] → Target (URI)
```

All data travels in **Envelopes**:

```typescript
interface Envelope<T = unknown> {
  item: T;
  items?: T[];   // batch/window channel — never implicit
  meta: { chapterId?: string; paragraphId?: string; lineId?: string; [k: string]: unknown };
}
```

Cardinality changes only via DSL ops (`.batch(n)`, `.window(n)`, `.flatMap()`).

A pipeline is a real TypeScript module — `import`, `console.log`, conditionals all work. The DSL (`definePipeline`) is only the orchestration grammar.

---

## 3. Core Abstractions (Summary)

| Concept | Shape / Role | Deep spec |
|---|---|---|
| **Domain** | `Book` → `Chapter` → `Paragraph` → `Line` (plain interfaces) | [`core.md`](steering/core.md) |
| **Source** | `start()` / `resume()`; lifestyle `long-lived` or `resumable` | [`core.md`](steering/core.md), [`waypoint.md`](steering/waypoint.md) |
| **Tool** | `invoke(env, ctx) → Promise<Envelope<O>>`; `exec: 'inproc' | 'npx' ...` | [`core.md`](steering/core.md), [`tools.md`](steering/tools.md) |
| **Target** | `open()` → `write()` → `close()`; URI-addressed | [`core.md`](steering/core.md), [`waypoint.md`](steering/waypoint.md) |
| **Envelope** | `{ item, items?, meta }` — single or batch | [`core.md`](steering/core.md) |
| **Context chain** | `GlobalContext → RunContext → ToolContext/SourceContext/TargetContext` (backrefs, never copies) | [`core.md`](steering/core.md) |
| **Pipeline DSL** | `.from()` `.use()` `.fork()` `.subflow()` `.batch()` `.to()` | [`core.md`](steering/core.md) |
| **Run state** | `pending → running → [checkpoint → paused → resumed →] done/failed` | [`core.md`](steering/core.md) |
| **Checkpoint tree** | Persisted depth-first replay graph; resume skips `done` nodes | [`core.md`](steering/core.md) |

---

## 4. Module Map

| Package | Role | Steering file |
|---|---|---|
| `@mt/core` | Types, DSL, URI registry, Runner engine, built-in Sources/Targets | [`core.md`](steering/core.md) |
| `@mt/cli` | `mt` binary; loads pipelines via `tsx`/`jiti` (no consumer build step) | [`cli.md`](steering/cli.md) |
| `@mt/tools` | Chapter processing tools (validator, splitter, translator, schema-doc, …) | [`tools.md`](steering/tools.md) |
| `@mt/waypoint` | Source/Target implementations; URI scheme registrations (side-effect import) | [`waypoint.md`](steering/waypoint.md) |
| `@mt/backend` | Nuxt/Nitro admin API + SSE event stream + SQLite indicator; serves frontend | [`backend.md`](steering/backend.md) |
| `@mt/frontend` | Vue 3 + Tailwind admin UI (bundled into backend) | [`structure.md`](steering/structure.md) |
| `@mt/router` | Standalone Nuxt: OpenRouter proxy, key pool, cost tracking, mock mode | [`router.md`](steering/router.md) |
| `@mt/mcp` | MCP server over stdio; wraps core/cli — no HTTP | [`mcp.md`](steering/mcp.md) |
| `chrome-extension` | MV3 — scrape chapters, auto-upload to web editors | [`extensions.md`](steering/extensions.md) |
| `vscode-extension` | JSON schema for `mt.json`, DSL hover, "Run pipeline" code lens | [`extensions.md`](steering/extensions.md) |

Import layer rules:
- `cli/` → `core/` only (never reverse)
- `backend/`, `mcp/` call `core/` programmatically
- `frontend/` → `backend/` API only (no direct `core` import)
- `router/` is standalone (no dependency on other `@mt/*` packages except shared config types)
- Extensions communicate via HTTP or MCP, never direct imports.

For full workspace layout, see [`structure.md`](steering/structure.md).

---

## 5. Key Runtime Concepts (Summary)

- **Run lifecycle**: `pending → running → checkpoint → paused → resumed → done | failed`. Every state transition writes atomically to `.mt/runs/<runId>/state.json` (temp + rename).
- **Concurrency**: In-process (`p-limit`-style limiter from URI/DSL/global); out-of-process via `npx`/`deno`/`bun` over stdio JSON; `.fork()` creates nested checkpoint subtrees; `.subflow()` is the lightweight in-process variant.
- **Retry & error**: `RetryPolicy` (`fixed` | `linear` | `exp`); `ErrorPolicy` (`fail-run` | `skip-item` | `dead-letter`). Merge order: tool step > pipeline > global (`mt.json`). Dead-letter writes to `.mt/runs/<id>/dead-letter.jsonl`.
- **Caching**: When `cacheable === true`, output is memoised by content hash at `.mt/cache/<hash>.json`. Replay short-circuits the tool; cache is never required for correctness.
- **URI schemes** (registered by `@mt/waypoint` as side-effects): `jsonl://`, `md://`, `http://`/`hs://`, `chapter://`, `schema-doc://`, `git://`.

---

## 6. `.mt/` Runtime State (Summary)

```
.mt/
├── runs/<runId>/
│   ├── state.json             # state machine snapshot
│   ├── checkpoint.json        # checkpoint tree (resume source of truth)
│   ├── context.json           # frozen run context
│   ├── events.jsonl           # append-only event log (SSE source)
│   ├── dead-letter.jsonl      # failed envelopes (when onError: 'dead-letter')
│   ├── logs/<stepId>.log
│   └── artifacts/             # intermediate outputs
├── cache/                     # tool memoisation
├── schedules/                 # reserved (post-MVP)
├── worktrees/                 # git worktree roots when used
└── backend/
    ├── server.log
    └── mt.sqlite              # indicator/metadata only (v1)
```

`mt.json` (project root) holds project/book metadata, pipeline paths, secrets env file (`.env`), model defaults, and global retry/concurrency defaults.

---

## 7. Details Index

Every topic below links to the steering file that holds the full specification, interface listings, code examples, and implementation notes.

| Topic | Steering file |
|---|---|
| Product overview, concepts, services, execution flows | [`product.md`](steering/product.md) |
| Tech stack, Biome, TypeScript rules, naming, import layers | [`tech.md`](steering/tech.md) |
| Workspace layout, package map, source trees, key rules | [`structure.md`](steering/structure.md) |
| Core: types (`Envelope`, `Source`, `Tool`, `Target`), DSL, URI registry, Runner, checkpoint tree, state machine, retry, cache, store | [`core.md`](steering/core.md) |
| CLI commands (`init`, `run`, `resume`, `ls`, `inspect`, `serve`, `router`, `mcp`) | [`cli.md`](steering/cli.md) |
| Tools catalogue (`validator`, `splitter`, `translator`, `schema-doc`, `md-formatter`, `openrouter-tool`) | [`tools.md`](steering/tools.md) |
| URI schemes (`jsonl`, `md`, `http`, `chapter`, `schema-doc`, `git`) | [`waypoint.md`](steering/waypoint.md) |
| Backend (Nuxt): routes, SSE, SQLite, runner registry, frontend integration | [`backend.md`](steering/backend.md) |
| Router (standalone Nuxt): OpenRouter proxy, pool, cost tracking, mock mode, logs | [`router.md`](steering/router.md) |
| MCP server (stdio): methods, handlers, test shape | [`mcp.md`](steering/mcp.md) |
| Chrome extension (MV3) & VS Code extension (schema, hover, code lens) | [`extensions.md`](steering/extensions.md) |

---

*This document is intentionally brief. Deep interface definitions, per-module architecture tests, build commands, and implementation plans live in the linked steering files and in `docs/tdd.md`, `docs/uc.md`, `docs/tools.md`.*
