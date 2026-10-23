# AGENTS.md

This file provides guidance to work with code in this repository.

## Required skills

The following skills MUST be invoked (via the `skills` tool) before any work on this repository:

- `caveman` - ultra-terse communication style
- `i-have-adhd` - ADHD-friendly planning/output style
- `codegraph` - code graph navigation for the codebase
- `delegate-with-at` (optional) - delegate code changes to a sub-agent via `at` while focusing on reasoning/coordination

Invoke the first three at the start of every task. Do not skip.

**Delegation mechanisms - pick one per task, never both for the same work:** prefer the host's built-in/native
subagents (for example architect / coder / qa via the Agent tool) over `delegate-with-at` (`at` agents). If a task is
already handled by a native subagent, don't double-delegate to `at` (and vice versa).

---

## What this project is

**machinum-pipeline** (package name: `mt`) is a TypeScript ETL engine for processing long-form text (primarily books)
through composable, checkpointable, partially-out-of-process tool chains.

Core data flow: `Source (URI) → [Tool → Tool → …] → Target (URI)`. All data travels in **Envelopes**
(`{ item, items?, meta }`); cardinality changes only via DSL ops (`.batch(n)`, `.window(n)`, `.flatMap()`).

Full context lives in docs - read on demand:

| Doc | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | High-level architecture, run lifecycle, `.mt/` state dir |
| [docs/uc.md](docs/uc.md) | Use cases |
| [docs/tools.md](docs/tools.md) | Tool catalogue |
| [docs/kanban.md](docs/kanban.md) | Task board / roadmap (managed via `at kanban`; plans in [docs/plans/](docs/plans/)) |
| [docs/change-workflow.md](docs/change-workflow.md) | Mandatory worktree → branch → gates → FF-merge lifecycle |
| [docs/samples.md](docs/samples.md) | Sample projects + how to run them manually |
| [docs/adding-a-sample.md](docs/adding-a-sample.md) | How to add a new sample (layout, scripts, IT pattern, checklist) |

## Steering files

Steering files live in `docs/steering/`. Read the relevant one **before editing**:

| File | When to read |
|---|---|
| [product.md](docs/steering/product.md) | Product concepts, domain model, data flow |
| [tech.md](docs/steering/tech.md) | Toolchain, code style, Biome, test conventions, env vars |
| [structure.md](docs/steering/structure.md) | Workspace/package layout, import layer rules, URI schemes |
| [core.md](docs/steering/core.md) | `packages/core/` - types, DSL, engine, URI registry |
| [tools.md](docs/steering/tools.md) | `packages/tools/` - adding/modifying processing tools |
| [waypoint.md](docs/steering/waypoint.md) | `packages/waypoint/` - URI schemes, Source/Target impls |
| [cli.md](docs/steering/cli.md) | `packages/cli/` - commands, pipeline loading |
| [router.md](docs/steering/router.md) | `packages/router/` - OpenRouter proxy, cost tracking |
| [backend.md](docs/steering/backend.md) | `packages/backend/` - admin API, SSE, SQLite |
| [mcp.md](docs/steering/mcp.md) | `packages/mcp/` - MCP server, stdio handlers |
| [extensions.md](docs/steering/extensions.md) | `packages/chrome/` or `packages/vscode/` |

## Commands

```bash
pnpm install        # Install
pnpm build          # Build all packages (Turborepo)
pnpm lint           # Lint (Biome - no ESLint/Prettier)
pnpm format         # Auto-fix lint/format
pnpm typecheck      # Type-check all packages
pnpm test           # All tests (workspace + sample integration tests)
pnpm test --filter=@mt/tools                    # Tests for one package
pnpm --filter=@mt/tools exec vitest run src/chapter-validator.ts   # One test file
pnpm dev --filter=@mt/core                      # Dev watch mode
```

## Quick architecture map

Packages: `@mt/core` (types, DSL, Runner engine) → `@mt/cli` (binary) + `@mt/backend`/`@mt/mcp` (programmatic
callers); `@mt/tools` (chapter processing tools); `@mt/waypoint` (URI-scheme Sources/Targets, side-effect
registration via `import '@mt/waypoint'`); `@mt/router` (standalone OpenRouter proxy); `@mt/frontend` (admin UI);
`chrome/` + `vscode/` extensions.

Key types in `packages/core/src/`: `domain.ts` (`Book`, `Chapter`, … - Sources provide stable IDs, the engine never
mints them), `types.ts` (`Source`/`Tool`/`Target`/`Envelope`), `contexts.ts` (layered `GlobalContext → RunContext →
ToolContext`, backrefs never copies), `dsl.ts` (`definePipeline()` etc.), `uri.ts` (URI registry),
`engine/runner.ts` + `state-machine.ts` + `checkpoint.ts` (execution, `pending → running → [checkpoint → paused →
resumed →] done/failed`, crash recovery).

Pipeline DSL shape (full reference in [steering/core.md](docs/steering/core.md)):

```typescript
export default definePipeline()
  .from('jsonl://./input.jsonl')   // string URI (preferred)
  .flatMap(async (item) => [...])  // fan-out: one → many
  .tap(async (item) => { /* logging */ })
  .use(myTool)                     // Tool<I, O>
  .subflow(otherPipeline)          // inline nested pipeline (same Runner)
  .fork(subPipeline)               // child Runner + nested checkpoint subtree
  .batch(5)                        // group into items[]
  .to('md://./output.md')
```

**Pipelines are real TS modules** - plain `import`, `console.log`, conditionals all work. The DSL is only the
orchestration grammar.

## Code style (summary)

Biome enforces everything: 2-space indent, single quotes, no semicolons, trailing commas, `printWidth: 100`;
`noExplicitAny`/`noNonNullAssertion` are errors. TS strict (`strict`, `noUncheckedIndexedAccess`): `interface` for
public API shapes, `type` for unions, `import type` for type-only, no `any` (`unknown` + narrowing). Files
`kebab-case.ts`, types `PascalCase`, builders `define*` prefix, conventional commits. Tests: co-located
`*.test.ts`, `describe`/`it`. Full rules: [steering/tech.md](docs/steering/tech.md).

## Hard rules

- **Change workflow** - never code on `main`; worktree + branch → code → test/lint gate → commit → samples IT gate →
  rebase onto `main`, then FF-merge only (`git merge --ff-only`) → cleanup.
  **Regular merge commits are forbidden** — never use `git merge --no-ff` or merge without rebase.
  Full state machine: [docs/change-workflow.md](docs/change-workflow.md).
- **Import layers** - `cli/`/`backend/`/`mcp/` → `core/` only (never reverse); `frontend/` → backend API only;
  `router/` standalone; extensions via HTTP/MCP, never direct imports. ([steering/structure.md](docs/steering/structure.md))
- **File writes are atomic** (temp-then-rename); the checkpoint tree is the only resume mechanism.
- **Do not run git mutations** (commit/push/reset/rebase) unless explicitly asked.
- **NEVER** `git stash` or `git reset` (`--hard`/`--mixed`/`--soft`) without explicit user approval - working tree
  changes are load-bearing, do not discard them.
- **NEVER** add `Co-Authored-By` (or any AI-attribution trailer) to commits or PR descriptions.

## Communication rules

- You are not alone - other agents may work in this repo concurrently. Focus on your task; ignore unrelated errors.
- Caveman/ultra-brief reports. Minimal texting, save tokens.
- ADHD-friendly output (from `i-have-adhd` skill): lead with the next action; number multi-step work; restate state
  across turns; specific time estimates; matter-of-fact tone for errors (state cause + fix, no "uh oh"); cap visible
  lists at ~5 items; no preamble, no recap, no closing pleasantries - start with the answer, end when it's done.

## Environment variables

`OPENROUTER_API_KEYS` (comma-separated key pool), `MT_ROUTER_URL` (default `http://localhost:7777`),
`MT_LOG_LEVEL`, `MT_DEBUG`. Secrets load from `.env` via `mt.json → secrets.envFile`.
Full table: [steering/tech.md](docs/steering/tech.md#environment-variables).
