# machinum-pipeline

**machinum-pipeline** (`mt`) is a text-processing engine built for long-form content — primarily books.
It takes a manuscript from a source (a file, an HTTP endpoint, a git worktree), pushes it through a chain of
processing tools (validation, splitting, translation, formatting…), and writes the result to a target —
reliably, resumably, and observable.

## Why it exists

Processing a book is not one script. It is dozens of steps — validate chapters, split oversized ones, translate,
count words, generate summaries, write out per-language files. Steps fail, APIs rate-limit, runs crash halfway.
`mt` treats that whole chain as a first-class object: describe it once, run it, pause it, resume it after a crash,
and watch it live.

## Key ideas

- **Pipelines as code** — a pipeline is a plain TypeScript module. Use real imports, conditionals, loops. No YAML
  orchestration language to learn.
- **Everything is resumable** — progress is recorded in a checkpoint tree. A crashed or paused run picks up exactly
  where it stopped; completed work is never redone.
- **Composable tools** — small single-purpose tools chain together. Fan out with `flatMap`, group with `batch`,
  branch with `fork`, nest with `subflow`.
- **Sources and targets as URIs** — `jsonl://./in.jsonl`, `md://./out`, `hs://localhost:8080`, `git://…?worktree`.
  Swapping input/output means swapping a string.
- **Safe by default** — atomic file writes (no half-written state), git worktree isolation, dead-letter queue for
  failed items instead of losing them.
- **Human + machine interface** — run from the CLI, watch via a web admin UI with live event stream, or drive it
  from an editor / MCP-compatible agent.

## What runs where

| Component | What it is |
|---|---|
| `@mt/core` | The engine: pipeline DSL, runner, checkpointing |
| `@mt/cli` | The `mt` command-line tool |
| `@mt/tools` | Ready-made book-processing tools (validator, splitter, translator…) |
| `@mt/waypoint` | Built-in sources & targets (files, HTTP, git worktrees) |
| `@mt/router` | Optional OpenRouter proxy with API-key pooling and cost tracking |
| `@mt/backend` + `@mt/frontend` | Admin web UI with live run monitoring |
| `@mt/mcp` | MCP server — let AI agents drive pipelines |
| Chrome / VS Code extensions | Scrape chapters from the browser, run pipelines from the editor |

## Quickstart

```bash
# As a library / CLI from npm
npm i mt tsx
# pipeline.ts:  import { definePipeline } from 'mt'; import { chapterDoc } from 'mt/tools'
NODE_OPTIONS='--import tsx' npx mt run ./pipeline.ts

# Or as one self-contained binary (no node needed): build with Bun
pnpm build:bin && ./packages/mt/dist/bin/mt run ./pipeline.ts
```

## A pipeline, in one glance

```typescript
export default definePipeline()
  .from('jsonl://./book.jsonl')   // read chapters
  .use(chapterValidator)          // validate structure
  .flatMap(splitOversized)        // one chapter → many chunks
  .use(translateText)             // translate via LLM
  .batch(5)                       // group for output
  .to('md://./output')            // write markdown files
```

## Documentation

- [docs/architecture.md](docs/architecture.md) — how it works under the hood
- [docs/uc.md](docs/uc.md) — use cases
- [docs/tools.md](docs/tools.md) — tool catalogue
- [docs/kanban.md](docs/kanban.md) — roadmap / task board
- [AGENTS.md](AGENTS.md) — guidance for AI coding agents working in this repo

## Status

Pre-1.0, active development. All planned phases through the sample projects are implemented.
