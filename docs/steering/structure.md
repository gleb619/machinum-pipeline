# Project Structure
← [Architecture](../architecture.md)

## Workspace Layout

```
machinum-pipeline/
├── packages/
│   ├── core/        @mt/core    — types, DSL, engine, URI registry, built-in Sources/Targets
│   ├── cli/         @mt/cli     — `mt` binary; pipeline loader, all CLI commands
│   ├── tools/       @mt/tools   — chapter processing tools (validator, splitter, translator, …)
│   ├── waypoint/    @mt/waypoint — Source/Target implementations; URI scheme registrations (side-effects)
│   ├── mt/          mt          — publishable umbrella: `import … from 'mt'`, `mt/tools`, `mt/waypoint`; bin `mt`; Bun binary build
│   ├── router/      @mt/router  — standalone Nuxt: OpenRouter proxy, key pool, cost tracking
│   ├── backend/     @mt/backend — admin API (h3), SSE, SQLite indicator; Nitro for dev
│   ├── frontend/    @mt/frontend — Vue 3 + Tailwind admin UI (bundled into backend)
│   ├── mcp/         @mt/mcp    — MCP server over stdio
│   ├── chrome/                 — MV3 Chrome extension
│   └── vscode/                 — VS Code extension (JSON schema + code lens)
├── samples/
│   ├── sample0/    — `mt init` integration test
│   ├── sample1/    — HTTP → JSONL pipeline (`hs://` source)
│   └── sample2/    — Multi-tool: JSONL → tools → fork → batch → MD
├── docs/
│   ├── tdd.md       — Architecture spec
│   ├── uc.md        — 54 use cases
│   ├── tools.md     — Tool catalogue
│   ├── kanban.md — Implementation roadmap (managed via `at kanban`)
│   ├── steering/    — docs/steering/ (legacy; Kiro steering is in .kiro/steering/)
│   └── plans/       — Per-feature implementation plans
├── biome.json
├── turbo.json
├── tsconfig.base.json
└── pnpm-workspace.yaml
```

## @mt/core — Canonical Source Layout

```
packages/core/src/
├── domain.ts         # Book, Chapter, Paragraph, Line interfaces
├── types.ts          # Source<T>, Tool<I,O>, Target<T>, Envelope<T>, Lifecycle, RunState
├── contexts.ts       # GlobalContext → RunContext → ToolContext chain (backrefs, no copies)
├── dsl.ts            # definePipeline(), defineTool(), defineSource(), defineTarget()
├── uri.ts            # UriRegistry: registerSource/Target, resolveSource/Target, parse
├── config.ts         # mt.json loader and shape
├── settings.ts       # getSetting() helper
├── store.ts          # Store: atomic file reads/writes under .mt/
├── discovery.ts      # discoverPipelines()
├── index.ts          # Public re-exports
└── engine/
    ├── runner.ts         # Runner: start(), pause(), resume(), state management
    ├── state-machine.ts  # RunStateMachine: transition(), canTransition(), isTerminal()
    ├── checkpoint.ts     # createRootCheckpoint(), walkTree(), markDone/Failed/InProgress
    ├── cache.ts          # Cache: content-hash keyed tool output memoisation
    ├── dead-letter.ts    # writeDeadLetter() — failed envelopes
    ├── retry.ts          # withRetry(), getBackoff()
    ├── git.ts            # autoCommit(), execGit()
    └── git-worktree.ts   # createWorktree(), removeWorktree(), mergeWorktreeToMain()
```

## `mt` — Umbrella Package (`packages/mt`)

Leaf package that aggregates the workspace; nothing imports it. Name `mt` is the npm name.

| Entry | Re-exports |
|---|---|
| `mt` | `@mt/core` (DSL, types, Runner) + side-effect registration of `@mt/waypoint` URI schemes |
| `mt/tools` | `@mt/tools` |
| `mt/waypoint` | `@mt/waypoint` |
| bin `mt` | `@mt/cli` `main()` (`dist/bin.js`) |

Build: `tsc` (src → `dist/*.js`) then `scripts/assemble.mjs` copies built `@mt/{core,tools,waypoint,cli}`
into `dist/<name>/` and rewrites `@mt/*` specifiers to relative paths, so `npm pack` yields a standalone
tarball (third-party deps listed in `dependencies`; `better-sqlite3` is optional; `mt serve` also uses `h3`; admin UI copied to `dist/ui`).
Binary: `scripts/build-bin.ts` (Bun.build `compile`) → `dist/bin/mt` or `dist/bin/mt-<os>-<arch>` with `--target` (excluded from the tarball). Embeds `dist/ui` (admin UI) and includes `mt serve`.
Details: [plan](../plans/bun-binary-and-mt-package.md).

## @mt/cli — Source Layout

```
packages/cli/src/
├── index.ts          # main(); arg parsing, command dispatch
├── commands/
│   ├── run.ts        # mt run <pipeline>
│   ├── resume.ts     # mt resume <runId>
│   ├── init.ts       # mt init
│   ├── list.ts       # mt ls runs
│   ├── inspect.ts    # mt inspect <runId>
│   ├── tool.ts       # mt tool <name>
│   └── serve.ts      # mt serve [--detach] (lazy-imports @mt/backend/standalone)
└── utils/
    ├── logger.ts     # DuplexLogger (console + file)
    └── args.ts       # parseInitArgs()
```

## @mt/waypoint — URI Schemes

Import `'@mt/waypoint'` as a side-effect to register all URI schemes:

| Scheme | File | Description |
|---|---|---|
| `jsonl://` | `jsonl.ts` | JSONL file source/target; supports glob patterns |
| `md://` | `md.ts` | Markdown file source/target |
| `hs://` / `http://` | `http-server.ts` | Long-lived HTTP source (POST endpoint) |
| `chapter://` | `chapter-output.ts` | Chapter output (language-folder target) |
| `schema-doc://` | `schema-doc.ts` | Per-chapter schema-doc output |
| `git://` | `git-worktree.ts` | Git worktree-aware source/target with optional commit |
| (ephemeral) | `ephemeral.ts` | In-memory source/target for tests |

## @mt/tools — Tool Catalogue

All tools live in `packages/tools/src/`, each as a `defineTool()` export:

| File | Exports | Purpose |
|---|---|---|
| `chapter-validator.ts` | `chapterValidator`, `forbiddenCharDetector`, `typoFinder`, `markdownFormatter` | Structural validation, forbidden chars, broken links |
| `chapter-doc.ts` | (internal helpers) | Chapter YAML-frontmatter doc read/write |
| `schema-doc.ts` | `readDoc`, `writeDoc`, `schemaDocWriter`, `SchemaDocEnvelope` | mdshape schema-doc format + writer (no LLM call) |
| `schema/` | `summaryTool`, `entitiesTool`, `schemaTool`, `metadataTool`, `vocabularyTool` (+ `create*Tool`) | LLM extraction per section via `runPromptWithRetry`, retry loop guard + deterministic fallback |
| `translate-text.ts` | `translateText` | Chapter-level translation via OpenRouter |
| `chapter-translator.ts` | (invokes translateText) | Full chapter translation pipeline |
| `openrouter-tool.ts` | `chatCompletion`, `runPrompt` | Low-level OpenRouter chat completion |
| `md-formatter.ts` | `mdFormatterTool` | Markdown reformatting with configurable width |
| `token-splitter.ts` | (internal) | Split chapters at paragraph boundaries respecting token limits |
| `word-counter.ts` | `wordCounter` | Word count per envelope |
| `chapter-indexer.ts` | (internal) | Chapter indexing/ordering |

## Runtime State Directory (`.mt/`)

Created by `mt init` in consumer projects, not part of this repo.

```
.mt/
├── runs/<runId>/
│   ├── state.json        # State machine snapshot
│   ├── checkpoint.json   # Checkpoint tree (resume source of truth)
│   ├── events.jsonl      # Append-only event log (SSE source)
│   └── dead-letter.jsonl # Failed envelopes (when onError: 'dead-letter')
└── cache/                # Tool output memoisation (content-hash keyed)
```

All file writes use atomic temp-then-rename to prevent corruption on crash.

## Consumer Project Layout

```
my-book-project/
├── package.json     # devDependency on @mt/core, @mt/cli, @mt/waypoint
├── mt.json          # Project config (book metadata, pipeline paths, secrets, defaults)
├── pipelines/
│   ├── ingest.ts
│   └── translate.ts
└── .mt/             # Runtime state (gitignored)
```

## Key Architecture Rules

- `core/` has zero external runtime dependencies beyond TypeScript stdlib
- `cli/` imports from `core/` and `waypoint/` only — never the reverse (sole exception: `mt serve` imports `@mt/backend/standalone`, lazily, so the CLI starts without h3/SQLite)
- `router/` is standalone — zero `@mt/*` imports and zero `@mt/*` deps in its `package.json` (enforced by `packages/router/tests/layers.arch.test.ts`); the OpenRouter key pool is therefore a deliberate copy of `packages/tools/src/core/openrouter-pool.ts`, kept in sync by hand
- `waypoint/` sources/targets register themselves via URI registry side-effects
- Sources provide stable IDs — engine never mints domain entity IDs
- Pipelines loaded at runtime via `tsx`/`jiti` — no consumer build step
- All file writes are atomic (write temp → rename) — no partial state on crash
- Checkpoint tree is the only resume mechanism — no implicit "last good state"
- Tools always run in-process — the engine calls `tool.invoke()` directly
