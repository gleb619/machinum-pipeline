# Onboarding — machinum-pipeline at a glance

Simple arch digest for coding agents. Deep specs live in [architecture.md](architecture.md), [steering/](steering/), [tools.md](tools.md); tasks in [kanban.md](kanban.md) (managed by `at kanban` only).

## What it is

Pluggable, resumable document-processing orchestration engine for long-form text (books), with first-class EN→RU translation. Core flow: `Source (URI) → [Tool → Tool → …] → Target (URI)`. Pipelines are plain TypeScript modules using a thin DSL. Pre-1.0, active development.

- Monorepo: pnpm 9 workspaces + Turborepo, Biome (lint+format), Vitest, tsx/jiti.
- Node ≥ 20, ESM, strict (`noUncheckedIndexedAccess`). Also: Bun single-file binary, Nuxt/Nitro router, Vue 3 frontend, h3 + better-sqlite3 backend, MCP server, Chrome/VS Code extensions.

## Package map

| Package | Role |
|---|---|
| `@mt/core` | Engine: types, domain, contexts, DSL, URI registry, Runner, checkpoint tree, state machine, retry/cache/dead-letter/store/vault. **Zero runtime deps; may not import other @mt/\* pkgs** (enforced by `*.arch.test.ts`) |
| `@mt/tools` | Book tools: LLM toolkit (gate/client/prompts/decorators/translates), normalization (glossary, term-tagger, translation-prompt/stage, summaries, typo-fix), verification (chapter-validator, line-parity/pairs linters), modification (chapter-translator, md outputs) |
| `@mt/waypoint` | Source/Target URI implementations: `jsonl://`, `md://`, `hs://http://`, `chapter://`, `schema-doc://`, `git://` (worktree), `range://` (source), `void://` (target) |
| `@mt/cli` | `mt` binary: `init`, `run`, `resume`, `ls runs`, `inspect`, `tool`, `serve`, `router`, `vault` |
| `@mt/router` | Standalone keyless LLM gateway: OpenRouter proxy, API-key pool, upstream routing by model prefix, cost/budget tracking, `/api/translate` |
| `@mt/backend` + `@mt/frontend` | Admin API (h3) + SSE + SQLite; Vue 3 UI |
| `@mt/mcp` | MCP server (stdio) so AI agents drive pipelines |
| `mt` | Publishable umbrella (`import from 'mt'`, `mt/tools`, `mt/waypoint`) + Bun binary |

## Core abstractions

- **`Exchange<T> { id, item, items?, meta, variables }`** (`Envelope` = deprecated alias) — the only data carrier; cardinality changes only via DSL ops `.batch(n)` / `.window(n)` / `.flatMap()`.
- Domain: `Book → Chapter → Paragraph → Line` (plain interfaces, stable IDs).
- `Source { uri, start(ctx), resume?(ctx,cursor) }`, `Target { uri, open/write/close }`, `Tool { name, version, invoke(env,ctx), cacheable? }`.
- Contexts: `GlobalContext → RunContext → ToolContext` (backrefs, never copies). Built from `mt.json` + `.env`.
- **Runner** (`core/src/engine/runner.ts`): one recursive `buildStream()` drives all nesting. `.fork()` = child Runner + nested checkpoint subtree; `.subflow()` = inline in-process nesting.
- **Checkpoint tree** (`checkpoint.ts`): persisted depth-first replay graph; resume skips `done` nodes; source cursor counted as Target accepts envelopes.

## LLM integration

- **Composable LLM gate** (`tools/core/llm-gate.ts`): slot chain `prepare → fit → call → parse → emit`, each slot a Tool. Presets: `openrouterFree`, `openrouterPool` (sticky free-model pinning), `ollamaTool`, `llmTranslate`, `translateText` (router or direct).
- Providers: OpenRouter (free/paid), Ollama, OpenAI-compatible, Anthropic, `router` (keyless gateway; only `MT_ROUTER_TOKEN` client-side).
- **Vault**: `~/.mt/vault.json` / `<root>/.mt/vault.json` — provider/baseUrl/keys storage; refs like `@vault/entry/model` in `llm.use`.
- Prompts: template registry `llm-prompts.ts` (overridable per tool / mt.json); `buildTranslationPrompt()` injects only glossary terms whose `<term id>` occurs in the unit.
- Validation: `cleanTranslation()` strips think-blocks/term tags; **line-parity-linter** checks line count, empty/bracketed line positions, leftover tags, Cyrillic ratio; failures throw retryable `LineParityError` → engine retry + content-hash cache re-send only failed lines.

## State & resume

Everything under `.mt/`: `runs/<id>/{state.json, checkpoint.json, events.jsonl, dead-letter.jsonl, artifacts/}`, `cache/` (content-hash tool memo), `vault.json`, `worktrees/`. `Tool.cacheable === true` → `.mt/cache/<hash>.json`. Error policies: `fail-run | skip-item | dead-letter`.

## Commands

```bash
pnpm build        # turbo
pnpm test         # turbo test + sample integration suites (sample0..3)
pnpm test:gpu     # GPU-gated IT (real ollama + keyless router)
pnpm lint / format / typecheck   # biome + tsc
NODE_OPTIONS='--import tsx' npx mt run ./pipeline.ts   # run a pipeline
```

Canonical translation sample: `samples/sample4/pipelines/` — `analyze.ts` (summaries + glossary) → `normalize.ts` → `translate.ts` (titles batched by 5, body line-by-line, parity-linted, output via `@chapters` URI alias).

## Gotchas

- `@mt/core` must stay dependency-free; arch tests enforce import layers.
- Kanban board (`docs/kanban.md`) is machine-mutated — only via `at kanban`, never hand-edit.
- Vault files are gitignored secrets; never log key material.
- `MT_MOCK_FLAKY` in sample4 IT simulates a bad LLM reply to prove parity-lint + retry works offline.
