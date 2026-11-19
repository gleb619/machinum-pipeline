# AGENTS.md

Guidance for coding agents in this repo. Humans: see [README.md](README.md).

## Required skills

Invoke via `skills` tool at start of every task, never skip:

- `caveman` - ultra-terse communication
- `i-have-adhd` - ADHD-friendly planning/output
- `codegraph` (optional) - only if mentioned for code context
- `at` (optional) - delegate code changes to a sub-agent via `at` while you coordinate

## Project

**machinum-pipeline** (pkg `mt`): TypeScript ETL engine for long-form text (books) through composable,
checkpointable, partially out-of-process tool chains.

Flow: `Source (URI) → [Tool → Tool → …] → Target (URI)`. Data travels in **Exchanges**
`{ id, item, items?, meta, variables }`; cardinality changes only via DSL ops (`.flatMap()`, the batch subflow `.subflow('batch://?size=N', pipe)`).

Docs: `docs/steering/` = agent-facing dev docs, `docs/guiding/` = human-facing ([layout](docs/README.md)).
Read the relevant steering file **before editing**:

| File | When |
|---|---|
| [product.md](docs/steering/product.md) | Domain model, data flow |
| [tech.md](docs/steering/tech.md) | Toolchain, style, Biome, tests, env vars |
| [structure.md](docs/steering/structure.md) | Package layout, import layers, URI schemes |
| [core.md](docs/steering/core.md) | `packages/core/` types, DSL, engine, URI registry |
| [tools.md](docs/steering/tools.md) | `packages/tools/` add/modify tools |
| [waypoint.md](docs/steering/waypoint.md) | `packages/waypoint/` Sources/Targets |
| [cli.md](docs/steering/cli.md) | `packages/cli/` commands, pipeline loading |
| [router.md](docs/steering/router.md) | `packages/router/` OpenRouter proxy |
| [webui.md](docs/steering/webui.md) | `packages/webui/` admin API, SSE, SQLite |
| [tui.md](docs/steering/tui.md) | `packages/tui/` terminal UI (HTTP-only) |
| [mcp.md](docs/steering/mcp.md) | `packages/mcp/` MCP server |
| [extensions.md](docs/steering/extensions.md) | `packages/chrome/`, `packages/vscode/` |
| [layout.md](docs/steering/layout.md) | UI layout contract (`components/` + `tui/`) |

Other: docs/guiding/{architecture,installation,samples,adding-a-sample,mock-tools}.md, docs/SKILL.md (printed by
`mt skill`), docs/change-workflow.md, docs/kanban.md (via `at kanban`; plans in `docs/plans/`).

## Commands

```bash
pnpm install | build | lint | format | typecheck   # lint = Biome + docs md/mermaid gate
pnpm lint:md                                       # markdownlint docs gate + mermaid render check
pnpm test                                          # workspace + sample IT
pnpm test --filter=@mt/tools                       # one package
pnpm --filter=@mt/tools exec vitest run src/chapter-validator.ts   # one file
pnpm annotations [--kind tool|waypoint|useCase|category] [--json]  # needs pnpm build first
pnpm tools [--json]                               # tool catalogue as a Markdown table (needs pnpm build first)
pnpm build:bin                                     # standalone `mt` binary (Bun --compile)
```

## Architecture map

`@mt/core` (types, DSL, Runner) → `@mt/cli` (binary) + `@mt/webui`/`@mt/mcp`; `@mt/tools` (chapter tools);
`@mt/waypoint` (URI Sources/Targets, registered by `import '@mt/waypoint'`); `@mt/router` (standalone proxy);
`@mt/components` (admin UI, shared with the VS Code webview); `@mt/tui` (HTTP-only); `chrome/` + `vscode/` extensions.

Key files in `packages/core/src/`: `domain.ts` (Sources give stable IDs, engine never mints), `exchange.ts`,
`types.ts` (`Source`/`Tool`/`Target`), `contexts.ts` (`GlobalContext → RunContext → ToolContext`, backrefs not
copies), `dsl.ts` (`definePipeline()`), `uri.ts`, `engine/{runner,state-machine,checkpoint}.ts`
(`pending → running → [checkpoint → paused → resumed →] done/failed`, crash recovery).

DSL: `definePipeline().from(uri).flatMap().tap().use(tool).subflow().fork().subflow('batch://?size=N', pipe).to(uri)`. Pipelines are real TS modules; full DSL: steering/core.md.

## Annotations

Dev-only markers (`tool()` TL###, `waypoint()` WT###, `useCase()` UC###, `category([...])`); no runtime effect.
List: `pnpm annotations`.

## Code style

Biome: 2-space, single quotes, no semicolons, trailing commas, `printWidth: 100`; `noExplicitAny` /
`noNonNullAssertion` errors. TS strict + `noUncheckedIndexedAccess`: `interface` for public shapes, `type` for
unions, `import type`, `unknown` + narrowing. Files `kebab-case.ts`, types `PascalCase`, builders `define*`,
conventional commits. Tests co-located `*.test.ts`, `describe`/`it`. Full: steering/tech.md.

## Hard rules

- **Default: use native subagents** (architect, coder, qa via the Agent tool) for nearly every task; coordinate them yourself.
- Only use `at` when the user explicitly asks for it or names `at`; if you'd reach for `at`, check native subagents first.
- **You are not alone.** Focus on your task and ignore other agents' errors — but never silently: register each observed error/broken test as a kanban task via the `at` kanban feature (`at kanban add --title "..." --description "..."`) for the owner, and keep working on your own slice.
- **`at` feedback is for `at` itself only.** Log every bug/friction/idea about the `at` agent tool via `at feedback add -k bug|improvement "<text>" -T <tags>` (tags AFTER the text; variadic `-T` swallows it), one entry per issue, with evidence (command, output, error string). File immediately, never ask permission. Suspicion is enough — no reproduction or root cause needed; do not investigate or patch. Check `at feedback list` first to update an existing entry instead of duplicating. Filing is not a deliverable: it never replaces your own task.
- **Project improvements go to kanban.** If you see a way to improve machinum-pipeline (code, docs, process, decisions), register a kanban task via the `at` kanban feature — not in `at feedback`. Self-improvement loop: notice → register → keep working; never silently work around or leave it unrecorded.
- Minimal texting, save tokens.
- **Work in English.** Code, comments, commit messages, docs, reports and conversation stay in English. Use another language only when the user explicitly instructs it.
- Web fetch / external facts: run the tunnelstack WebBridge CLI — `python3 ~/tunnelstack/src/webbridge.py sites` to list sites, then `ask|search|extract <site> "<arg>" [--json]` (path override: `AT_WEBBRIDGE`). Prefer api/rss-backed sites (github, habr, hf — no browser needed); chat sites (google-ai, deepseek, qwen) drive the owner's logged-in Chrome, use sparingly. Exit 1 = run failed, continue on your own knowledge.
- **Push only a working main** - `main` reaches the remote only when it is verified on that exact
  commit: typecheck clean, `pnpm test` green, `pnpm ci:local` green (plus `packages/tools` project
  typecheck, which the root `tsc` sweep skips). Never push first and repair afterwards, never leave
  a red `main` on the remote: everyone else branches from it. A branch may be pushed for review;
  `main` may not be. Force-push only to replace a broken remote `main` with a verified local one,
  and only with `--force-with-lease`.
- **Change workflow** - default: worktree + branch → code → test/lint gate → commit → samples IT gate → rebase
  onto `main` → `git merge --ff-only` → cleanup. **Simple tasks (tweak, sample edit, doc fix, single commit): stay
  put**, commit on current branch (usually `main`). **Explicit user override** (work in current worktree/`main`)
  wins. **Merge commits forbidden** (`--no-ff`, merge without rebase). State machine: docs/change-workflow.md.
- **GPU gate** - before any FF-merge run `pnpm test:gpu` (`packages/tools/tests/it/`, real ollama at
  `MT_OLLAMA_URL`; host-specific commands live in a gitignored local note) and report result.
  Excluded from `pnpm test`. Unreachable server **fails loudly** - report it, never skip silently or claim pass.
- **wrkflw guard** - before any FF-merge run `pnpm ci:local` (lint incl. docs md/mermaid gate +
  typecheck + wrkflw validate + Docker jobs; needs `wrkflw` + Docker), report one-line result. Failure to run = red. `pnpm ci:check` = fast validate-only loop.
- **Import layers** - `cli/`/`webui/`/`mcp/` → `core/` only, never reverse (`cli/` may also import `waypoint/` and
  lazy `webui/standalone` for `mt serve`; `webui/` may import `router/`); `components/` → webui API only;
  `router/` zero `@mt/*` deps; `tui/` HTTP-only; extensions via HTTP/MCP. See steering/structure.md.
- **Package ownership** - reusable Tool implementations live only in `packages/tools/src`; Source/Target/URI-scheme
  implementations live only in `packages/waypoint/src`. `packages/core` defines the primitives. Do not add a new
  package for pipeline glue or a tool collection. Samples may keep tiny one-off glue; reusable code is promoted to
  the owning package with tests and docs. Enforced by `pnpm lint:ownership`; `@mt/bookkit` is a temporary
  grandfather tracked in `docs/plans/bookkit-to-tools.md`.
- **API-change gate** - adding or moving a public API (DSL op, tool, URI scheme, exported type, package boundary)
  requires a design under `docs/plans/` and explicit user approval before implementation.
- **Atomic writes** (temp-then-rename); checkpoint tree is the only resume mechanism.
- **Agent skill current** - update `docs/SKILL.md` in same change for any new/changed/removed CLI command or flag,
  DSL op, URI scheme, tool category, vault/secret handling, config key, lifecycle change, install path. Bump
  `skill-version` + date, run `pnpm --filter=@mt/cli gen:skill` (`pnpm build` too), verify `mt skill` matches.
  Drift test: `packages/cli/tests/commands/skill.test.ts`.
- **Binary freshness** - after changing `core`/`tools`/`waypoint`/`cli`/`router`/`webui`, run `pnpm build:bin` and
  `pnpm smoke:bin`. Stale binary runs old code.
- **No git mutations** (commit/push/reset/rebase) unless asked.
- **NEVER** `git stash` or `git reset` (any mode) without explicit approval - working tree is load-bearing.
- **NEVER** add `Co-Authored-By` or AI-attribution trailers to commits/PRs.

## Logging (hard rule)

Every runtime log line (Runner, CLI lifecycle, tools, sources, targets) = exactly one line via `formatLogLine`
from `@mt/core`:

```text
<ISO-8601 UTC ms timestamp> [<LEVEL>] <message>[ <compact-json-meta>]
```

- time: `new Date().toISOString()`, never bare `HH:MM:SS.mmm`.
- level: `[DEBUG]` `[INFO]` `[WARN]` `[ERROR]`.
- message: single line; human formats (console, `run.log`, `logs/<step>.log`) escape CR/LF as `\n`, TAB as `\t`
  (`escapeLogNewlines`).
- meta: optional compact JSON, omit when empty. JSON/JSONL outputs (`events.jsonl`, `--json`) keep real newlines.
- Runtime code never calls `console.*`. Use `ctx.run.logger` (tools/sources/targets), CLI `DuplexLogger`, or
  `createConsoleLogger()` outside context. In pipelines use `log()` / `log.info|warn|error|debug` from `@mt/core`.
  Plain command output (help, tables, prompts, machine JSON) is not a log line. Exceptions: sample pipelines
  printing test markers; `console://` target.
- Tests assert this single format.

## Communication

- Other agents may work here concurrently; ignore unrelated errors.
- Caveman/ultra-brief. ADHD-friendly (`i-have-adhd`): lead with next action; number multi-step work; restate state
  across turns; specific time estimates; matter-of-fact errors (cause + fix); cap lists ~5 items; no preamble,
  recap, or closing pleasantries.

## Env vars

`OPENROUTER_API_KEYS` (comma pool), `MT_ROUTER_URL` (default `http://localhost:7777`), `MT_LOG_LEVEL`, `MT_DEBUG`.
Secrets from `.env` via `mt.json → secrets.envFile`. Vault `apiKey`/`apiKeys[]` refs: `vlt:<name>` (`MT_VLT=false`
off), `keepass:<title|uuid>` (`MT_KEEPASS_PATH`, `MT_KEEPASS_PASSWORD`/`_FILE`, `MT_KEEPASS_KEY_FILE`;
`MT_KEEPASS=false` off), `embed:<name>` (`MT_EMBED_PATH`, `MT_EMBED_PASSWORD`/`_FILE`; `MT_EMBED=false` off).
Full table: steering/tech.md.
