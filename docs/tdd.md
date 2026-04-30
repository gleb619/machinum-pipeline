# `tdd.md` — Mt: Pluggable Document Processing Orchestration Engine

> **Status:** Draft v0.1
> **Audience:** Core engineering, contributors, integrators
> **Scope:** Architecture, module boundaries, data model, runtime semantics, milestones

---

## 1. Vision & Goals

**MT** is a TypeScript library + CLI for building ETL-style pipelines that process long-form text (primarily books)
through composable, checkpointable, partially-out-of-process tool chains. MT stands is for Machinima Translate.

It is consumed as a dev dependency in another TS project. The consumer authors **pipelines as real `.ts` files** (a thin
DSL embedded in real code), declares project metadata in `mt.json`, and invokes the engine via `mt` CLI. Mt produces
artifacts (jsonl, md, pdf, epub) and persists run state under `.mt/`.

### Primary goals

- **Pluggable**: Sources, Tools, Targets are interfaces; tools can run in-process or as short-lived `npx`/`deno`/`bun`
  child processes via stdio JSON.
- **Resumable**: Per-Run state machine with checkpoint tree; any crash is recoverable to the last completed step.
- **Parallel by design**: Fork-join over Chapters/Paragraphs/Lines; nested pipelines; controllable batching/windowing.
- **Hybrid runtime**: Same code runs from CLI (foreground or detached) or from a Nuxt-based admin server.
- **Git-aware (opt-in)**: Specialised Source/Target wrap worktree create/remove so forked processing never touches
  master data.
- **Observable**: File-based event log is the source of truth; backend tails it and streams to UI via SSE.

### Non-goals (v1)
- Distributed execution across machines.
- Hot-reloading pipelines while a Run is in flight.
- Built-in scheduling daemon (folder reserved in `.mt`, deferred).

---

## 2. Tech Stack

| Concern           | Choice                                          |
|-------------------|-------------------------------------------------|
| Language          | TypeScript (strict)                             |
| Lint/format       | Biome                                           |
| Repo              | pnpm workspaces + Turborepo                     |
| Pipeline loading  | `tsx` / `jiti` (no build step for consumers)    |
| Frontend          | Vue 3 + Tailwind                                |
| Build (frontend)  | Vite (lib pieces), Nuxt (backend + router apps) |
| Server            | Nuxt (Nitro) — backend & router                 |
| Storage (engine)  | Filesystem under `.mt/` (source of truth)       |
| Storage (backend) | SQLite (queryable view; v1 indicator only)      |
| Docs              | VitePress                                       |
| LLM gateway       | Custom Nuxt proxy in front of OpenRouter        |

---

## 3. Repository Layout

```
mt/
├── pnpm-workspace.yaml
├── turbo.json
├── biome.json
├── tsconfig.base.json
├── package.json
└── packages/
    ├── docs/              # VitePress site
    ├── cli/               # `mt` binary; root entrypoint
    ├── core/              # types, DSL, engine, built-in S/T/T, .mt store
    ├── backend/           # Nuxt: admin API + WS/SSE + serves frontend
    ├── frontend/          # Vue + Tailwind admin UI (built into backend)
    ├── router/            # Nuxt: OpenRouter proxy (standalone)
    ├── mcp/               # MCP server; calls cli/core via stdio
    ├── chrome-extension/  # MV3 extension
    └── vscode-extension/  # mt.json schema, DSL hover, "Run pipeline" lens
```

Consumer project layout:

```
my-book-project/
├── package.json           # depends on mt, calls `mt run` in scripts
├── mt.json                # project & book metadata
├── pipelines/
│   ├── ingest.ts
│   ├── fix-typos.ts
│   └── publish.ts
└── .mt/                   # created by `mt init`
```

---

## 4. Domain Model

```ts
// core/src/domain.ts
export interface Book {
  id: string;
  name: string;
  author?: string;
  year?: number;
  meta?: Record<string, unknown>;
}

export interface Chapter {
  id: string;          // provided by Source
  bookId: string;
  url?: string;
  title: string;
  body: string;        // markdown
  index?: number;
}

export interface Paragraph {
  id: string;          // provided by Source
  chapterId: string;
  body: string;
  index?: number;
}

export interface Line {
  id: string;
  paragraphId: string;
  text: string;
  index?: number;
}
```

**Identity rule:** Sources provide stable IDs. Engine never mints IDs for domain entities. Engine *does* mint `runId`,
`stepId`, `forkId` for its own bookkeeping.

---

## 5. Core Abstractions

### 5.1 Contexts (layered, with backrefs)

```ts
export interface GlobalContext {
  project: { name: string; root: string };
  book?: Book;
  defaults: { retry: RetryPolicy; onError: ErrorPolicy; concurrency: number };
  routerUrl?: string;
  env: Record<string, string>;
}

export interface RunContext {
  runId: string;
  pipelineId: string;
  startedAt: string;
  global: GlobalContext;
  checkpoint: CheckpointHandle;
  logger: Logger;
}

export interface ToolContext  { run: RunContext; step: StepInfo; }
export interface SourceContext{ run: RunContext; }
export interface TargetContext{ run: RunContext; }
```

Every context carries a reference to its parent — never a copy.

### 5.2 Item envelope

```ts
export interface Envelope<T = unknown> {
  item: T;          // single-item channel
  items?: T[];      // batch/window channel (explicit; never auto-fanned-out)
  meta: {
    chapterId?: string;
    paragraphId?: string;
    lineId?: string;
    [k: string]: unknown;
  };
}
```

Cardinality changes only via DSL ops (`.batch(n)`, `.window(n)`, `.flatMap()`).

### 5.3 Source / Tool / Target

```ts
export type Lifestyle = 'long-lived' | 'resumable';

export interface Source<T> {
  uri: string;                       // e.g. "jsonl://./book.jsonl?batchSize=5"
  lifestyle: Lifestyle;
  start(ctx: SourceContext): AsyncIterable<Envelope<T>>;
  resume?(ctx: SourceContext, cursor: unknown): AsyncIterable<Envelope<T>>;
}

export interface Tool<I, O> {
  name: string;                      // unique; used for npx invocation
  version: string;
  // Pure call signature — same code runs in-process or via stdio adapter.
  invoke(env: Envelope<I>, ctx: ToolContext): Promise<Envelope<O>>;
  exec?: 'inproc' | 'npx' | 'deno' | 'bun'; // default: 'inproc'
  cacheable?: boolean;               // enables content-hash memoisation
  idempotent?: boolean;
}

export interface Target<T> {
  uri: string;                       // e.g. "jsonl://./out.jsonl"
  open(ctx: TargetContext): Promise<void>;
  write(env: Envelope<T>, ctx: TargetContext): Promise<void>;
  close(ctx: TargetContext): Promise<void>;
}
```

### 5.4 Pipeline DSL

```ts
import { definePipeline, source, target } from 'mt/core';
import { fixTypos, validate } from './tools';
import paragraphPipeline from './paragraph.pipeline';

export default definePipeline({
  id: 'fix-book-typos',
  retry: { max: 3, backoffMs: 1000, strategy: 'exp' },
  onError: 'fail-run',
})
  .from(source('jsonl://./book.jsonl?batchSize=5'))
  .use(fixTypos)
  .fork(paragraphPipeline)         // nested pipeline; first-class primitive
  .use(validate, { retry: { max: 5, backoffMs: 500 } })
  .to(target('jsonl://./out.jsonl?git=worktree'));
```

DSL operators: `.from`, `.to`, `.use`, `.batch(n)`, `.window(n)`, `.flatMap(fn)`, `.fork(subPipeline)`, `.tap(fn)`.

**Pipelines are real TS modules.** `console.log`, conditionals, imports — all execute. The DSL is the *grammar* for
orchestration; everything else is plain TS.

---

## 6. URI DSL

Sources and Targets are addressable by URI strings. Query params configure runtime behaviour.

| Scheme                   | Role                                 | Example                                  |
|--------------------------|--------------------------------------|------------------------------------------|
| `jsonl://`               | File source/target                   | `jsonl://./book.jsonl?batchSize=5`       |
| `http://` / `https://`   | Long-lived source (server) or target | `http://0.0.0.0:7000/in?path=/chapter`   |
| `git://`                 | Git operations                       | `git://./?worktree=auto&commit=on-close` |
| `fs://`                  | Filesystem dir source/target         | `fs://./chapters?glob=*.md`              |
| `stdin://` / `stdout://` | Pipe ops                             | `stdout://?format=ndjson`                |

Common query params: `batchSize`, `windowSize`, `concurrency`, `git=worktree`, `commit=on-close|never|per-item`.

URIs can be **joined** as composites, declared by registered higher-order schemes, e.g. `git+http://...` to combine git
lifecycle with an HTTP source.

---

## 7. Execution Model

### 7.1 Run state machine

```
   ┌──────────┐
   │ pending  │
   └────┬─────┘
        ▼
   ┌──────────┐    every step boundary    ┌────────────┐
   │ running  │ ─────────────────────────▶│ checkpoint │
   └────┬─────┘                           └─────┬──────┘
        │                                        │
        ▼            user/system signal          ▼
   ┌──────────┐ ◀──────────────────────── ┌────────────┐
   │  done    │                           │   paused   │
   │  failed  │                           └─────┬──────┘
   └──────────┘                                 │
                                                ▼
                                          ┌────────────┐
                                          │  resumed   │ ──▶ running
                                          └────────────┘
```

Coarse states are persisted to `.mt/runs/<id>/state.json`. Fine-grained progress is the **checkpoint tree** (§7.3).

### 7.2 Concurrency primitives

- **In-process**: per-step concurrency via `p-limit`-style limiter, knob from URI/DSL/global.
- **Out-of-process**: tools with `exec: 'npx' | 'deno' | 'bun'` are invoked as child processes:
  - One-shot: `echo '<env+ctx-json>' | npx some-tool` → stdout JSON.
  - Streaming: NDJSON over stdio for tools that consume many items.
- **Forks**: `.fork(subPipeline)` creates a nested Run rooted in the parent's checkpoint tree.

### 7.3 Checkpoint tree

```
Run
├── step:toolA            ✓ done (output hash: h1)
├── step:toolB            ⟳ in-progress
│   ├── fork:0 (chapterX) ✓ done
│   ├── fork:1 (chapterY) ⟳ in-progress
│   │   └── subRun: paragraph-pipeline
│   │       ├── step:fix    ✓
│   │       └── step:validate  ⟳
│   └── fork:2 (chapterZ) … pending (gated)
└── step:toolC            … pending
```

**Replay rule:** Walk the tree depth-first. Skip nodes marked `done`. Resume the first non-done node. Sibling forks are
sequential by status: a later fork (`fork:2`) is **not** started until earlier ones (`fork:0`, `fork:1`) reach a
terminal state.

### 7.4 Retry & error policy

```ts
type RetryStrategy = 'fixed' | 'linear' | 'exp';
interface RetryPolicy { max: number; backoffMs: number; strategy: RetryStrategy; }
type ErrorPolicy = 'fail-run' | 'skip-item' | 'dead-letter';
```

Merge order (highest wins): **tool step > pipeline > global (`mt.json`)**.

`dead-letter` writes the offending envelope + error to `.mt/runs/<id>/dead-letter.jsonl`.

### 7.5 Caching

When `tool.cacheable === true`, output is memoised by `hash(toolName + version + input + relevantContext)` at
`.mt/cache/<hash>.json`. Replay short-circuits the tool. Cache is project-scoped, never required for correctness.

---

## 8. `.mt` Layout

```
.mt/
├── runs/
│   └── <runId>/
│       ├── state.json             # run state machine snapshot
│       ├── checkpoint.json        # checkpoint tree
│       ├── context.json           # frozen run context
│       ├── events.jsonl           # append-only event log (source of truth for UI)
│       ├── dead-letter.jsonl
│       ├── logs/
│       │   └── <stepId>.log
│       └── artifacts/             # intermediate outputs
├── cache/                         # tool memoisation
├── schedules/                     # reserved (post-MVP)
├── worktrees/                     # git worktree roots when used
└── backend/
    ├── server.log                 # if started detached
    └── mt.sqlite                  # queryable mirror (v1: indicator only)
```

`mt.json` (project root):

```json
{
  "project": { "name": "my-book" },
  "book": { "name": "...", "author": "...", "year": 2024 },
  "storage": { "root": ".mt" },
  "secrets": { "envFile": ".env" },
  "router": { "port": 7777 },
  "model": { "default": "anthropic/claude-opus-4.7" },
  "defaults": {
    "retry": { "max": 3, "backoffMs": 1000, "strategy": "exp" },
    "onError": "fail-run",
    "concurrency": 4
  },
  "pipelines": [
    "./pipelines/ingest.ts",
    "./pipelines/fix-typos.ts",
    "./pipelines/publish.ts"
  ]
}
```

---

## 9. Modules

### 9.1 `core`
- Types & domain model (§4, §5)
- DSL builders: `definePipeline`, `defineTool`, `defineSource`, `defineTarget`
- URI registry & parser
- Engine: `Runner`, state machine, checkpoint store, child-process tool runner
- Built-in Sources/Targets: `jsonl`, `http`, `fs`, `stdin`, `stdout`, `git`
- `.mt` reader/writer (file-based, atomic writes via temp+rename)

### 9.2 `cli`
Binary `mt`. Loads pipelines via `tsx`/`jiti` — no consumer build step.

| Command                    | Purpose                                                                            |
|----------------------------|------------------------------------------------------------------------------------|
| `mt init`                  | Scaffold `mt.json`, `.mt/`, sample pipeline                                        |
| `mt run <pipeline.ts>`     | Execute pipeline (foreground; logs to console + `.mt`)                             |
| `mt resume <runId>`        | Resume from last checkpoint                                                        |
| `mt ls runs`               | List runs                                                                          |
| `mt inspect <runId>`       | Show state, tree, last events                                                      |
| `mt tool <name>`           | Invoke a registered tool standalone (stdio JSON)                                   |
| `mt serve [-d \|--detach]` | Start backend (in-process by default; detached writes to `.mt/backend/server.log`) |
| `mt router [-d]`           | Start router                                                                       |
| `mt mcp`                   | Run MCP server over stdio (no HTTP)                                                |

CLI hosts backend in-process by default; `--detach` spawns it.

### 9.3 `backend` (Nuxt)
- Serves the built `frontend` app
- HTTP API: list runs, inspect run, start/pause/resume, list pipelines
- SSE stream: tail `.mt/runs/<id>/events.jsonl` to frontend
- SQLite present (v1: indicator only; future: search index across runs/books/chapters)
- **Optional**: long-lived HTTP Sources mount routes onto the same Nitro server when a Run requests it

### 9.4 `frontend` (Vue + Tailwind)
**MVP screens:**
1. Runs list with status & progress
2. Run detail (logs view, basic state)
3. Pipelines registry with "Run" button
4. Link to router dashboard

**Post-MVP:** tree-of-tools live view, charts (cost, throughput), Books/Chapters browser, `.mt` file explorer, schedules.

### 9.5 `router` (standalone Nuxt)
- OpenAI-compatible facade in front of OpenRouter
- Per-Run / per-Tool cost & usage tracking (attributed via header `X-Mt-Run-Id`, `X-Mt-Step-Id`)
- Rate limiting, retry, fallback model selection
- Offline/mock mode for tests
- **No SQLite.** Logs at `~/.mt/router/<YYYY-MM-DD>/log.json`, rolling at 5 MB, retained N days
- Shares `.mt` for project-scoped attribution when invoked from a Run
- Admin UI in backend has a link that opens router dashboard in a new tab

### 9.6 `mcp`
MCP server over stdio. No HTTP. Wraps cli/core directly.

Capabilities exposed:
- `pipelines.list`
- `pipelines.run` (with arguments)
- `runs.list`, `runs.inspect`, `runs.pause`, `runs.resume`
- `tools.invoke` (single tool, single envelope)
- `book.read`, `chapter.read`

### 9.7 `chrome-extension` (MV3)
- Scrape chapter URLs/content from active tab → POST to a long-lived HTTP Source
- For specific Targets, automate writing chapter content into web editors (chapter upload automation)
- Configured with router/backend URL via extension options page

### 9.8 `vscode-extension`
- JSON schema for `mt.json` (validation + completion)
- DSL hover info on `definePipeline`, `.use`, `.fork`, etc.
- "Run this pipeline" code lens on default-exported pipeline files
- Syntax/semantic highlighting for the DSL chain

---

## 10. Key Sequences

### 10.1 `mt run ./pipelines/fix-typos.ts`
1. CLI loads `mt.json` → builds `GlobalContext`.
2. `tsx` loads pipeline module; `definePipeline` returns a `Pipeline` plan.
3. CLI starts backend in-process (unless `--no-backend`).
4. `Runner.start(plan)` mints `runId`, writes initial `state.json` (`pending → running`).
5. Source begins emitting envelopes; Runner walks DSL ops, executing tools.
6. Each step boundary: append to `events.jsonl`, update `checkpoint.json` atomically.
7. On `.fork`, Runner instantiates a child Runner sharing parent context, registers it as a checkpoint subtree.
8. On signal (SIGINT) or error per policy: transition `running → checkpoint → paused/failed`.
9. On success: `running → done`, Targets close (e.g. git commit if `commit=on-close`).

### 10.2 `mt resume <runId>`
1. Load `state.json`, `checkpoint.json`, `context.json`.
2. Walk checkpoint tree; identify first non-done node.
3. If Source is `resumable`, call `source.resume(ctx, cursor)` with stored cursor.
4. If Source is `long-lived`, re-attach (reconnect to HTTP server, re-subscribe).
5. Continue execution.

### 10.3 Out-of-process tool invocation
1. Runner serialises `{ envelope, toolContext }` to JSON.
2. Spawns `npx <tool-name>` (or deno/bun); writes JSON to stdin.
3. Reads single JSON object (or NDJSON stream) from stdout.
4. Validates against `Tool<I, O>` output shape; emits downstream.

---

## 11. Build & Tooling

- **pnpm workspaces** for hoisting; explicit `workspace:*` deps between packages.
- **Turborepo** pipelines: `build`, `dev`, `lint`, `typecheck`, `test`.
- **Biome** for both lint and format (no ESLint/Prettier).
- `tsconfig.base.json` with strict + project references; per-package `tsconfig.json`.
- `core` published as ESM-first dual package; `cli` ships compiled but loads consumer pipelines via `tsx`/`jiti`.

---

## 12. Testing Strategy

- **Unit (core)**: state machine transitions, checkpoint tree walk, URI parser, retry/backoff math.
- **Integration**: end-to-end pipelines using fixture jsonl in temp `.mt`, including crash-resume scenarios via injected
  faults.
- **Tool process contract**: spawn real child processes against canonical fixtures.
- **Router**: replay-mode tests with recorded fixtures; offline mock provider.
- **Backend**: route + SSE tests via Nitro test utils.

---

## 13. Milestones

### M1 — Engine spine (no UI)
- `core` types, DSL, jsonl source/target, in-proc tools, file-based checkpoints
- `cli`: `init`, `run`, `resume`, `ls runs`, `inspect`
- Single linear pipeline, retry/onError, in-proc concurrency
- Smoke test: ingest jsonl → toolA → toolB → jsonl

### M2 — Forks & out-of-process
- `.fork(subPipeline)` with nested checkpoints
- Child-process tools (`exec: 'npx' | 'deno' | 'bun'`)
- Cache layer
- Git source/target with worktree support

### M3 — Backend & frontend MVP
- Nuxt backend, SSE event tail, runs list + run detail + pipelines registry
- `mt serve`, `mt serve --detach`
- SQLite presence (empty schema + indicator)

### M4 — Router & integrations
- Router Nuxt app, cost/usage tracking, mock mode, log rolling
- MCP server (stdio)
- Long-lived HTTP source mounted on backend

### M5 — Extensions & polish
- VSCode extension (schema, hover, run lens)
- Chrome extension (scraper + uploader)
- VitePress docs site
- Frontend post-MVP screens (charts, tree view)

---

## 14. Open Questions / Deferred

- Schedules (`.mt/schedules/`): folder reserved; semantics deferred.
- Distributed runs across machines: out of scope.
- Hot-reload of running pipelines: out of scope.
- SQLite schema for backend search: deferred to post-MVP.
- Auth model for backend & router admin UIs: assumed localhost-only in v1; revisit before any remote deploy.

---

## 15. Glossary

- **Source** — Producer of envelopes. Lifestyle: `long-lived` or `resumable`.
- **Tool** — Pure function `Envelope<I> → Envelope<O>`; in-proc or child-process.
- **Target** — Sink that persists envelopes; may have open/close lifecycle (e.g. git commit).
- **Pipeline** — TS module exporting a DSL chain; real code, real imports.
- **Run** — One execution instance of a Pipeline; resumable.
- **Checkpoint tree** — Persisted execution graph used for replay.
- **Envelope** — `{ item, items?, meta }` transport unit.
- **`.mt`** — Per-project state directory (source of truth).
- **`mt.json`** — Project configuration root.