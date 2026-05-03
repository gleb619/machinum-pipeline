# Mt — Project Structure

## Root Layout

```
mt/
├── packages/
│   ├── cli/               # `mt` binary; root entrypoint. Commands: init, run, resume, ls runs, inspect, tool, serve, router, mcp
│   ├── core/              # Types, domain model, DSL builders, URI registry, engine (Runner, state machine, checkpoint store), built-in Sources/Targets
│   ├── backend/           # Nuxt (Nitro) app: admin API, SSE event stream, SQLite indicator. Serves built frontend
│   ├── frontend/          # Vue 3 + Tailwind admin UI: runs list, run detail, pipelines registry, router link
│   ├── router/            # Standalone Nuxt app: OpenRouter proxy with cost/usage tracking, rate limiting, mock mode
│   ├── mcp/               # MCP server over stdio: wraps cli/core — no HTTP
│   ├── chrome-extension/  # MV3 extension: scrape chapters from active tab, auto-upload to web editors
│   ├── vscode-extension/  # mt.json JSON schema, DSL hover info, "Run pipeline" code lens
│   └── docs/              # VitePress documentation site
├── pnpm-workspace.yaml    # Workspace definition
├── turbo.json             # Turborepo pipeline config
├── biome.json             # Biome lint + format config
├── tsconfig.base.json     # Base TS strict config with project references
└── package.json           # Root package.json (scripts, devDeps)
```

Consumer project layout:

```
my-book-project/
├── package.json           # Depends on mt; calls `mt run` in scripts
├── mt.json                # Project & book metadata, pipeline paths, defaults
├── pipelines/
│   ├── ingest.ts
│   ├── fix-typos.ts
│   └── publish.ts
└── .mt/                   # Created by `mt init`; run state, cache, logs, checkpoints
```

## Module Responsibilities

| Module             | Type              | Purpose                                                                                           |
|--------------------|-------------------|---------------------------------------------------------------------------------------------------|
| `cli`              | Runnable binary   | `mt` CLI commands; loads pipelines via `tsx`/`jiti`; hosts backend in-process by default          |
| `core`             | Library           | Types, DSL, engine, built-in Sources/Targets, URI registry, `.mt` file store                      |
| `backend`          | Nuxt app          | REST API + SSE for admin UI; optional SQLite (v1: indicator only); mounts long-lived HTTP Sources |
| `frontend`         | Vue SPA           | Admin UI — bundled into backend at build time                                                     |
| `router`           | Nuxt app          | OpenRouter proxy with cost/usage tracking; standalone; no SQLite                                  |
| `mcp`              | Library + CLI     | MCP server over stdio; wraps core API                                                             |
| `chrome-extension` | Browser extension | MV3 — chapter scraping + upload automation                                                        |
| `vscode-extension` | IDE extension     | Schema, hover, code lens                                                                          |
| `docs`             | VitePress site    | Documentation                                                                                     |

## Core Structure

```
packages/core/src/
├── domain.ts             # Book, Chapter, Paragraph, Line interfaces
├── types.ts              # Source, Tool, Target, Envelope, Lifecycle types
├── contexts.ts           # GlobalContext, RunContext, ToolContext, SourceContext, TargetContext
├── dsl.ts                # definePipeline, defineTool, defineSource, defineTarget builders
├── uri.ts                # URI registry, parser, composite scheme resolver
├── engine/
│   ├── runner.ts         # Main Runner — walks DSL ops, manages Run lifecycle
│   ├── state-machine.ts  # Run state transitions (pending/running/checkpoint/paused/done/failed)
│   ├── checkpoint.ts     # Checkpoint tree walker, reader/writer
│   └── child-process.ts  # Out-of-process tool runner (npx/deno/bun via stdio JSON)
├── builtins/
│   ├── jsonl-source.ts   # Stream lines from .jsonl file
│   ├── jsonl-target.ts   # Write envelopes to .jsonl
│   ├── http-source.ts    # Long-lived HTTP source (POST endpoint)
│   ├── http-target.ts    # HTTP target (POST envelopes to URL)
│   ├── fs-source.ts      # File system directory source (glob)
│   ├── fs-target.ts      # File system target (write files)
│   ├── git-source.ts     # Git worktree-aware source
│   ├── git-target.ts     # Git worktree target with optional commit
│   ├── stdin-source.ts   # StdIn source (pipe mode)
│   └── stdout-target.ts  # StdOut target (pipe mode)
└── store.ts              # .mt file reader/writer (atomic writes via temp+rename)
```

## CLI Structure

```
packages/cli/src/
├── index.ts              # Entrypoint; arg parsing, command dispatch
├── commands/
│   ├── init.ts           # mt init — scaffold project
│   ├── run.ts            # mt run <pipeline.ts> — execute pipeline
│   ├── resume.ts         # mt resume <runId> — resume from checkpoint
│   ├── ls.ts             # mt ls runs — list runs
│   ├── inspect.ts        # mt inspect <runId> — show run detail
│   ├── tool.ts           # mt tool <name> — invoke tool standalone
│   ├── serve.ts          # mt serve [-d|--detach] — start backend
│   ├── router.ts         # mt router — start router
│   └── mcp.ts            # mt mcp — start MCP server
└── utils/
    ├── logger.ts         # Console + file duplex logger
    └── config.ts         # mt.json loader
```

## Naming Rules

- **Files:** camelCase for modules (`jsonl-source.ts`, `state-machine.ts`), kebab-case for some monorepo configs (`biome.json`, `tsconfig.base.json`)
- **Classes/Interfaces:** PascalCase (`RunContext`, `Envelope`, `CheckpointHandle`)
- **DSL builders:** camelCase (`definePipeline`, `defineTool`)
- **Commands:** lowercase kebab (`mt ls runs`, `mt serve --detach`)
- **Tests:** co-located in `src/` with `.test.ts` suffix (`runner.test.ts`)

## Layer Rules

- `cli/` imports from `core/` only (never the reverse)
- `backend/`, `mcp/` call `core/` programmatically
- `frontend/` calls `backend/` API only (no direct core dependency)
- `router/` is standalone — no dependency on other packages except shared config types
- Extensions (`chrome-extension/`, `vscode-extension/`) communicate via HTTP or MCP, never via direct imports

## Test Structure

| Type           | Location                           | Runner                         |
|----------------|------------------------------------|--------------------------------|
| Unit           | `packages/*/src/**/*.test.ts`      | Vitest                         |
| Integration    | `packages/core/tests/integration/` | Vitest + temp `.mt` fixtures   |
| Tool process   | `packages/core/tests/process/`     | Real child process spawning    |
| Router (mock)  | `packages/router/tests/`           | Vitest + offline mock provider |
| Backend routes | `packages/backend/tests/`          | Nitro test utils               |

## Adding a New Built-in Source (Feature Checklist)

1. Create type class → `packages/core/src/builtins/<scheme>-source.ts` implementing `Source<T>`
2. Define URI scheme → register in `packages/core/src/uri.ts`
3. Write unit tests → `packages/core/src/builtins/<scheme>-source.test.ts`
4. Write integration test → `packages/core/tests/integration/<scheme>-source.test.ts`
5. Export from `packages/core/src/index.ts`
6. Add CLI help reference if relevant

## Adding a New CLI Command (Feature Checklist)

1. Create command file → `packages/cli/src/commands/<name>.ts`
2. Wire into dispatcher → `packages/cli/src/index.ts`
3. Add to help text
4. Write unit tests → `packages/cli/src/commands/<name>.test.ts`

## Critical Rules

- `core/` has zero external runtime dependencies beyond TypeScript stdlib
- Pipelines are loaded via `tsx`/`jiti` — no build step for consumers
- `.mt/` is the source of truth — SQLite (when present) is a queryable view only
- Out-of-process tools communicate exclusively via JSON over stdio (one-shot or NDJSON stream)
- All file writes use atomic pattern (write to temp, rename) to prevent corruption on crash
- Checkpoint tree is the only mechanism for resume — no implicit "last good state"
