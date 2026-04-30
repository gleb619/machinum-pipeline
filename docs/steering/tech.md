# Mt — Tech Stack

## Backend (Engine + CLI + Admin)

| Layer              | Technology                                        |
|--------------------|---------------------------------------------------|
| Language           | TypeScript (strict mode)                          |
| Monorepo           | pnpm workspaces + Turborepo                       |
| Pipeline loading   | `tsx` / `jiti` (no build step for consumers)      |
| Lint/Format        | Biome (no ESLint/Prettier)                        |
| Frontend framework | Vue 3 + Tailwind CSS                              |
| Frontend build     | Vite (lib pieces), Nuxt (backend + router)        |
| Server framework   | Nuxt / Nitro                                      |
| Engine storage     | Filesystem under `.mt/` (source of truth)         |
| Backend storage    | SQLite (v1: indicator only; future: search index) |
| Docs               | VitePress                                         |
| LLM gateway        | Custom Nuxt proxy in front of OpenRouter          |

## Frontend (Admin UI)

| Layer     | Technology                |
|-----------|---------------------------|
| Language  | TypeScript                |
| Framework | Vue 3                     |
| Styling   | Tailwind CSS              |
| Bundling  | Vite (lib) + Nuxt (app)   |
| Real-time | SSE (tail `events.jsonl`) |

## Router (LLM Proxy)

| Layer        | Technology                                                                         |
|--------------|------------------------------------------------------------------------------------|
| Language     | TypeScript                                                                         |
| Framework    | Nuxt (standalone)                                                                  |
| Proxy target | OpenRouter                                                                         |
| Log storage  | Rolling files at `~/.mt/router/<YYYY-MM-DD>/log.json` (5 MB roll, retained N days) |
| Offline mode | Mock provider for deterministic tests                                              |

## Build System

**pnpm workspaces** (`pnpm-workspace.yaml`) with **Turborepo** (`turbo.json`) for orchestration. Explicit `workspace:*` deps between packages. `tsconfig.base.json` uses strict mode with project references; each package has its own `tsconfig.json` extending the base.

- `core` published as ESM-first dual package
- `cli` ships compiled but loads consumer pipelines via `tsx`/`jiti` at runtime

## Common Commands

### Install & Setup

```bash
# Install all workspace dependencies
pnpm install

# Type-check all packages
pnpm typecheck

# Lint and format
pnpm lint
pnpm format
pnpm lint --fix

# Build all packages
pnpm build

# Dev mode (watch mode for specific package)
pnpm dev --filter=core
```

### Testing

```bash
# Run all tests across workspace
pnpm test

# Run core tests with file watch
pnpm test --filter=core -- --watch

# Run single test file
pnpm test --filter=core -- src/engine/runner.test.ts

# Coverage
pnpm test -- --coverage
```

### CLI Usage (Consumer Perspective)

```bash
# Initialize a consumer project
mt init

# Run a pipeline (foreground, logs to console + .mt)
mt run ./pipelines/fix-typos.ts

# Resume a crashed/paused run
mt resume <runId>

# List all runs
mt ls runs

# Inspect a specific run
mt inspect <runId>

# Invoke a tool standalone (pipe JSON envelope)
echo '{...}' | mt tool <toolName>

# Start admin backend (in-process mode by default)
mt serve

# Start admin backend as background process
mt serve --detach

# Start LLM router proxy
mt router

# Start MCP server over stdio
mt mcp
```

### Infrastructure

```bash
# Start any Docker services (deferred — v1 is fully local)
# No infra needed for MVP; everything runs on filesystem
```

## Environment Variables

| Variable             | Default                 | Effect                                             |
|----------------------|-------------------------|----------------------------------------------------|
| `MT_HOME`            | `~/.mt`                 | Global state directory (router logs, etc.)         |
| `MT_ROUTER_URL`      | `http://localhost:7777` | OpenRouter proxy URL                               |
| `MT_LOG_LEVEL`       | `info`                  | Logging verbosity                                  |
| `MT_DEBUG`           | `false`                 | Enable debug output and verbose checkpoint logging |
| `OPENROUTER_API_KEY` | (from `.env`)           | OpenRouter API key for LLM proxy                   |

Secrets loaded from `mt.json` → `secrets.envFile` (defaults to `.env` in project root).

## Code Style Rules

### TypeScript

- Strict mode enabled in `tsconfig.base.json` — `strict: true`, `noUncheckedIndexedAccess: true`
- Use TypeScript `interface` for public API shapes (domain model, contexts)
- Use `type` for internal unions and utility types
- Prefer named exports over default exports
- `import type { ... }` for type-only imports
- No `any` — use `unknown` with type narrowing
- No `// @ts-ignore` or `// @ts-expect-error` without documented reason
- Use `readonly` on interface properties that should not mutate
- Async functions return `Promise<T>` explicitly (not inferred)

### Biome

- 2-space indent
- single quotes
- no semicolons
- trailing commas where valid
- `printWidth: 100`
- Rules: `noExplicitAny` = error, `noNonNullAssertion` = error

### Testing

- Test files co-located in `src/` with `.test.ts` suffix
- Use `describe`/`it` blocks (not `test`)
- Test descriptions should describe behaviour in business terms
- Integration tests use temp directories under `os.tmpdir()` for isolation
- Tool process tests spawn real `npx`/`deno`/`bun` subprocesses

### Domain Modelling

- Domain entities (`Book`, `Chapter`, `Paragraph`, `Line`) are plain interfaces, never classes
- Sources provide stable IDs — engine never mints IDs for domain entities
- Engine mints `runId`, `stepId`, `forkId` as `string` (UUID v4)
- Context objects carry backreference to parent — never a copy

### Naming

- Files: `kebab-case.ts` for utilities, `camelCase.ts` for modules with single export
- Types/Interfaces: `PascalCase`
- Functions: `camelCase`
- DSL builders: `define*` prefix (`definePipeline`, `defineTool`, `defineSource`, `defineTarget`)
- CLI commands: lowercase verbs (`run`, `resume`, `ls runs`, `inspect`)
- Error types: `PascalCase` with `Error` suffix

### Git

- Conventional commits: `type(scope): description`
- Branch names: `feature/`, `fix/`, `chore/` prefixes
- `.mt/` and `dist/` in `.gitignore` (per-project)
