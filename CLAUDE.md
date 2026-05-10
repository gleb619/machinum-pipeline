# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**machinum-pipeline** (package name: `mt`) is a TypeScript ETL engine for processing long-form text (primarily books)
through composable, checkpointable, partially-out-of-process tool chains. It is pre-implementation / active
development — not yet published. The architecture is fully specified in [docs/tdd.md](docs/tdd.md), use cases
in [docs/uc.md](docs/uc.md), and the implementation roadmap in [docs/scaffolding.md](docs/scaffolding.md).

---

## Commands

```bash
# Install
pnpm install

# Build all packages (Turborepo)
pnpm build

# Lint (Biome — no ESLint/Prettier)
pnpm lint

# Auto-fix lint/format
pnpm format

# Type-check all packages
pnpm typecheck

# Run all tests (workspace + sample integration tests)
pnpm test

# Run tests for a single package
pnpm test --filter=@mt/tools

# Run a single test file inside a package
pnpm --filter=@mt/tools exec vitest run src/chapter-validator.ts

# Dev watch mode for a specific package
pnpm dev --filter=@mt/core
```

Test files are co-located in `src/` with a `.test.ts` suffix. Use `describe`/`it` blocks (not `test`). Integration tests
for samples live under `samples/sample*/tests/`.

---

## Package map

| Package          | Path                 | Role                                                                          |
|------------------|----------------------|-------------------------------------------------------------------------------|
| `@mt/core`       | `packages/core/`     | Types, DSL builders, URI registry, Runner engine, built-in Sources/Targets    |
| `@mt/cli`        | `packages/cli/`      | `mt` binary; loads pipelines via `tsx`/`jiti` (no consumer build step)        |
| `@mt/tools`      | `packages/tools/`    | Chapter processing tools (validator, splitter, warnings, fixer, translator)   |
| `@mt/waypoint`   | `packages/waypoint/` | Source/Target implementations; registers URI schemes as side-effects          |
| `@mt/router`     | `packages/router/`   | Standalone Nuxt app; OpenRouter proxy with key pool, cost tracking, mock mode |
| `@mt/backend`    | `packages/backend/`  | Nuxt/Nitro admin API + SSE event stream + SQLite indicator; serves frontend   |
| `@mt/frontend`   | `packages/frontend/` | Vue 3 + Tailwind admin UI (bundled into backend at build time)                |
| `@mt/mcp`        | `packages/mcp/`      | MCP server over stdio; wraps core/cli — no HTTP                               |
| chrome-extension | `packages/chrome/`   | MV3 extension — scrape chapters, auto-upload to web editors                   |
| vscode-extension | `packages/vscode/`   | JSON schema for `mt.json`, DSL hover info, "Run pipeline" code lens           |

### Import layer rules

- `cli/` imports from `core/` only — never the reverse
- `backend/`, `mcp/` call `core/` programmatically
- `frontend/` calls `backend/` API only — no direct core dependency
- `router/` is standalone — no dependency on other packages except shared config types
- Extensions communicate via HTTP or MCP, never via direct imports

---

## Core architecture

### Data flow

```
Source (URI) → [Tool → Tool → …] → Target (URI)
```

All data travels in **Envelopes**: `{ item: T, items?: T[], meta: Record<string, unknown> }`. Cardinality changes only
via DSL ops (`.batch(n)`, `.window(n)`, `.flatMap()`).

### Key types (packages/core/src/)

- `domain.ts` — `Book`, `Chapter`, `Paragraph`, `Line` plain interfaces. Sources provide stable IDs; the engine never
  mints domain entity IDs.
- `types.ts` — `Source<T>`, `Tool<I,O>`, `Target<T>`, `Envelope<T>`, `Lifestyle`
- `contexts.ts` — `GlobalContext → RunContext → ToolContext` layered chain; each carries a backref to its parent (never
  a copy)
- `dsl.ts` — `definePipeline()`, `defineTool()`, `defineSource()`, `defineTarget()` builders
- `uri.ts` — URI registry & parser; Sources/Targets are addressed as URIs (e.g. `jsonl://./out.jsonl`,
  `md://./chapters`)
- `engine/runner.ts` — main `Runner` executing the DSL op chain; manages Run lifecycle
- `engine/state-machine.ts` — `pending → running → [checkpoint → paused → resumed →] done/failed`
- `engine/checkpoint.ts` — checkpoint tree walker; enables crash recovery

### URI schemes (registered by `@mt/waypoint` as side-effects)

| Scheme              | Description                                           |
|---------------------|-------------------------------------------------------|
| `jsonl://`          | JSONL file source/target                              |
| `md://`             | Markdown file source/target                           |
| `schema-doc://`     | Per-chapter schema-doc output target                  |
| `chapter://`        | Chapter output (language-folder target)               |
| `http://` / `hs://` | Long-lived HTTP source (POST endpoint)                |
| `git://`            | Git worktree-aware source/target with optional commit |

To use waypoint schemes in a pipeline: `import '@mt/waypoint'` (side-effect import).

### Pipeline DSL

```typescript
import { definePipeline, defineTool } from '@mt/core'
import '@mt/waypoint'

export default definePipeline()
  .from('jsonl://./input.jsonl')          // string URI (preferred) or source() wrapper
  .flatMap(async (item) => [...])         // fan-out: one → many
  .tap(async (item) => { /* logging */ })
  .use(myTool)                            // Tool<I, O>
  .subflow(otherPipeline)                 // inline nested pipeline (same Runner)
  .fork(subPipeline)                      // child Runner + nested checkpoint subtree
  .batch(5)                               // group into items[]
  .to('md://./output.md')
```

**Pipelines are real TS modules** — plain `import`, `console.log`, conditionals all work. The DSL is only the
orchestration grammar.

### OpenRouter key pool (`@mt/tools/src/openrouter-pool.ts`)

Round-robin across `OPENROUTER_API_KEYS` (comma-separated env var). Handles 429 (mark exhausted) and 402 (remove
permanently). Pool recreates on TTL expiry. Used by translation tools and the router proxy.

---

## Code style

**Biome** enforces all formatting and lint — 2-space indent, single quotes, no semicolons, trailing commas,
`printWidth: 100`. `noExplicitAny` and `noNonNullAssertion` are errors.

TypeScript strict mode (`strict: true`, `noUncheckedIndexedAccess: true`). Use `interface` for public API shapes, `type`
for internal unions. `import type { … }` for type-only imports. No `any` — use `unknown` with narrowing.

Files: `kebab-case.ts`. Types/Interfaces: `PascalCase`. DSL builders: `define*` prefix. Commits: conventional commits (
`type(scope): description`).

---

## `.mt/` — runtime state directory

Created by `mt init` in consumer projects. Not part of this repo. Contains:
- `runs/<runId>/state.json` — state machine snapshot
- `runs/<runId>/checkpoint.json` — checkpoint tree (resume source of truth)
- `runs/<runId>/events.jsonl` — append-only event log (SSE source for UI)
- `runs/<runId>/dead-letter.jsonl` — failed envelopes when `onError: 'dead-letter'`
- `cache/` — tool output memoisation (content-hash keyed)

All file writes use atomic temp-then-rename to prevent corruption on crash.

---

## Samples

| Sample  | Path              | What it demonstrates                                          |
|---------|-------------------|---------------------------------------------------------------|
| sample0 | `samples/sample0` | `mt init` integration test — validates scaffolded artifacts   |
| sample1 | `samples/sample1` | HTTP → JSONL pipeline (`hs://` source, `jsonl://` target)     |
| sample2 | `samples/sample2` | Multi-tool pipeline: JSONL → tools → fork → batch → MD output |

Running a sample manually requires packing local deps first:
```bash
cd samples/sample2
pnpm -C ../../packages/core pack --pack-destination ./vendor
pnpm -C ../../packages/cli pack --pack-destination ./vendor
npm install --no-audit --no-fund
pnpm run runner
```

---

## Environment variables

| Variable              | Effect                                                           |
|-----------------------|------------------------------------------------------------------|
| `OPENROUTER_API_KEYS` | Comma-separated OpenRouter keys; pool rotates across them        |
| `MT_ROUTER_URL`       | OpenRouter proxy URL (default `http://localhost:7777`)           |
| `MT_LOG_LEVEL`        | Logging verbosity (default `info`)                               |
| `MT_DEBUG`            | Enables debug output and verbose checkpoint logging              |

Secrets are loaded from `.env` in the consumer project (configured via `mt.json → secrets.envFile`).

---

## Implementation status

All phases through Phase 7 (sample projects) are `done`. See [docs/scaffolding.md](docs/scaffolding.md) for the full
task table and plan links. Architecture spec: [docs/tdd.md](docs/tdd.md). Use cases: [docs/uc.md](docs/uc.md). Tool
catalogue: [docs/tools.md](docs/tools.md).
