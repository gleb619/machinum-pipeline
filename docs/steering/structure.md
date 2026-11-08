# Project Structure
← [Architecture](../guiding/architecture.md)

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
│   ├── webui/       @mt/webui   — admin API (h3), SSE, SQLite indicator; Nitro for dev
│   ├── components/  @mt/components — Vue 3 + Tailwind admin UI (bundled into webui)
│   ├── tui/         @mt/tui     — terminal UI skeleton (HTTP-only client of `mt serve`; layout contract in [docs/layout.md](../layout.md))
│   ├── mcp/         @mt/mcp    — MCP server over stdio
│   ├── chrome/                 — MV3 Chrome extension
│   └── vscode/                 — VS Code extension (JSON schema + code lens)
├── samples/
│   ├── sample1-tutorial/  — ten numbered pipes, simple → complex
│   └── sample2-practical/ — real book2 EN→RU translation prep
├── docs/
│   ├── guiding/     — Architecture spec, use cases, samples, vault, onboarding
│   ├── steering/    — Per-package steering docs (incl. canonical tool catalogue)
│   ├── kanban.md    — Implementation roadmap (managed via `at kanban`)
│   └── plans/       — Per-feature implementation plans
├── biome.json
├── turbo.json
├── tsconfig.base.json
└── pnpm-workspace.yaml
```

## @mt/core — Canonical Source Layout

```
packages/core/src/
├── types/domain.ts   # active-record entities: Book, Chapter, Chunk, Paragraph, ParagraphLine, LineWord, Token
├── types.ts          # Source<T>, Tool<I,O>, Target<T>, Exchange<T> (Envelope alias), Lifecycle, RunState
├── contexts.ts       # GlobalContext → RunContext → ToolContext chain (backrefs, no copies)
├── dsl.ts            # definePipeline(), defineTool(), defineSource(), defineTarget(), defineWaypoint(), defineProcess()
├── process.ts        # Process types + isProcess() guard (runnable processes are built by defineProcess([...]))
├── uri.ts            # UriRegistry: registerSource/Target, resolveSource/Target, parse
├── config.ts         # mt.json loader and shape
├── settings.ts       # getSetting() helper
├── store.ts          # Store: atomic file reads/writes under .mt/
├── discovery.ts      # discoverPipelines()
├── sync/             # manifest, scope, diff, apply (project sync)
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
│   ├── explain.ts    # mt explain <pipeline> (declaration view, no execution)
│   ├── resume.ts     # mt resume <runId>
│   ├── init.ts       # mt init
│   ├── list.ts       # mt ls runs
│   ├── inspect.ts    # mt inspect <runId>
│   ├── info.ts       # mt info
│   ├── tool.ts       # mt tool <name>
│   └── serve.ts      # mt serve [--detach] (lazy-imports @mt/webui/standalone)
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
| `http://` / `https://` | `http-target.ts` | Outbound HTTP client target (one request per exchange) |
| `chapter://` | `chapter-output.ts` | Chapter output (language-folder target) |
| `schema-doc://` | `schema-doc.ts` | Per-chapter schema-doc output |
| `git://` | `git-worktree.ts` | Git worktree-aware source/target with optional commit |
| `range://` | `range.ts` | Integer range source (`<start>..<end>`, `?step=` magnitude) |
| `void://` | `void.ts` | Discard-everything target sink |
| `console://` | `console.ts` | Terminal target sink (stdout/stderr), per-envelope, target-only |
| `review://` | `review.ts` | Glossary pending-change review-queue target (markdown worksheet) |
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
| `text-splitter.ts` | `tokenSplitter`, `seriesSplitter` | Split chapters at paragraph boundaries respecting token limits; also hosts the series splitter |
| `token-splitter.ts` | `chunkSplit`, `chunkClean` | Fixate token-bounded chunks with separator lines; tokenize chunks into BPE tokens |
| `word-counter.ts` | `wordCounter` | Word count per envelope |
| `stat-freq.ts` | `statFreq`, `defineStatFreq` | Word / sentence / n-gram frequency report per envelope (offline) |
| `stat-dict.ts` | `statDict`, `defineStatDict` | Ranked translation dictionary from a frequency report, merged into an existing glossary (offline) |
| `chapter-indexer.ts` | (internal) | Chapter indexing/ordering |

## Runtime State Directory (`.mt/`)

Created by `mt init` in consumer projects, not part of this repo.

```
.mt/
├── runs/<runId>/
│   ├── state.json        # State machine snapshot + checkpoint tree (resume source of truth)
│   ├── context.json      # Frozen run context
│   ├── events.jsonl      # Append-only event log (SSE source)
│   ├── run.log           # CLI lifecycle log
│   ├── logs/<stepId>.log # Per-step engine/tool/source/target logs
│   ├── dead-letter.jsonl # Failed envelopes (when onError: 'dead-letter')
│   └── artifacts/        # Tool/target intermediate outputs
├── cache/                # Tool output memoisation (content-hash keyed)
└── remote/               # Project sync mirrors + last-synced hash map (T203)
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
- `cli/` imports from `core/` and `waypoint/` only — never the reverse (sole exception: `mt serve` imports `@mt/webui/standalone`, lazily, so the CLI starts without h3/SQLite)
- `tui/` is HTTP-only — it talks to `mt serve` over `/api/*` and imports no `@mt/*` package (see [tui.md](tui.md) and [../layout.md](../layout.md))
- `router/` is standalone — zero `@mt/*` imports and zero `@mt/*` deps in its `package.json` (enforced by `packages/router/tests/layers.arch.test.ts`); the OpenRouter key pool is therefore a deliberate copy of `packages/tools/src/core/openrouter-pool.ts`, kept in sync by hand. The one allowed cross-package direction is `webui/ → router/`: `mt serve` mounts the router API on its port via the `@mt/router` embeddable builder (T197); the router imports nothing back
- `waypoint/` sources/targets register themselves via URI registry side-effects
- Sources provide stable IDs — engine never mints domain entity IDs
- Pipelines loaded at runtime via `tsx`/`jiti` — no consumer build step
- All file writes are atomic (write temp → rename) — no partial state on crash
- Checkpoint tree is the only resume mechanism — no implicit "last good state"
- Tools always run in-process — the engine calls `tool.invoke()` directly

## Sandbox

`sandbox/` is a top-level playground outside the pnpm workspace globs and the turbo/`pnpm test` gates: a model bench (`sandbox/src/bench.ts`) that runs a built-in EN fixture through the LLM gate tools (`ollama`, `openrouter-free`, `openrouter-pool`, `mock`) and ranks models for EN->RU translation. It imports `packages/tools/src` by relative path and has its own deps (`pnpm --dir sandbox install --ignore-workspace`). See `sandbox/README.md`.
