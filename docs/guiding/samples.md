# Samples

Two runnable samples cover the feature set: a numbered tutorial and a practical book-translation
workflow. Both live in the pnpm workspace and double as integration tests.

| Sample | Path | What it demonstrates |
|---|---|---|
| sample1-tutorial | `samples/sample1-tutorial` | Ten numbered pipes, simple → complex: `from → use → to`, HTTP source + URI aliases + a custom waypoint, multi-tool chains/subflows/batch, `.fork()` branches, chunking + the structure ladder, stop/resume, normalize + analyze (summaries/glossary/`<term>` tagging), line-by-line EN→RU translation with parity lint, the LLM tool gallery, and the secret-backend demo. Input: `books/book1` plus deterministic lorem-ipsum fixtures. |
| sample2-practical | `samples/sample2-practical` | Real book translation prep against `books/book2` (21 chapters): extract EN chapters, batch-translate titles, extract a glossary, summarize each chapter for context, translate the body line by line with parity lint, and assemble the result with `bookCompiler` → `book://`. Output under `chapters/ru/` and `chapters/book/`. |

Adding a new sample: see [adding-a-sample.md](adding-a-sample.md).

## Tutorial pipe map

| Pipe | Lesson |
|---|---|
| `pipe01-beginning.ts` | Minimal source → shipped tool → target; typed chapter trees; `statFreq`; `console://` |
| `pipe02-waypoints.ts` | `hs://` HTTP ingestion, `@en` / `@ru` aliases, sample-owned `my-target://` |
| `pipe03-tools-multitool.ts` | Six-tool chain, `.batch(n)`, subflow composition |
| `pipe04-forks.ts` | Parallel `.fork('chapter-views', [...])` branches with isolated envelopes |
| `pipe05-chunks-ladder.ts` | `chunkSplit`, separator reuse, chunks → paragraphs → lines → words / tokens, series split |
| `pipe06-stop-resume.ts` | SIGINT pause, latch files, `mt resume` with no duplicate lines |
| `pipe07-normalize-analyze.ts` | Raw JSONL → clean markdown → summaries + glossary + `<term>` tagged text |
| `pipe08-translate-mock.ts` | Glossary-aware titles + line-by-line body translation, parity lint, plain/xml/properties modes |
| `pipe09-llm-tools.ts` | One tiny pipeline per LLM tool, side-by-side input/output reports |
| `pipe10-secrets.ts` | Vault ref resolution with the built-in `embed:` backend |

Integration tests live under `samples/*/tests/` and are part of the pre-merge gate
(see [change-workflow.md](../change-workflow.md)). Both samples use `fileParallelism: false`
because pipes share the sample directory.

## LLM backend

Every LLM-backed pipe goes through one pick (`pickLlmTool` from `@mt/tools`, wrapped by the
sample's `lib/llm.ts`):

- `MT_LLM_TOOL` = `router` | `openrouter-free` | `openrouter-pool` | `ollama` | `mock`
  (default `mock` — offline, no API key, no network).
- `MT_LLM_MODEL` selects the model.
- `mt.json` → `settings.llm.tool` / `settings.llm.model` are the file fallback; env wins. A
  gitignored `mt.local.json` imported by `mt.json` can hold local settings.

`sample2-practical` also supports per-pipe scope and prompt inspection:

```bash
MT_ONLY_CHAPTERS=1,2 pnpm run runner:chapters
MT_TRANSLATE_PROMPT_LOG=$PWD/.mt-translate-prompts.jsonl pnpm run runner:chapters
```

## Running a sample

```bash
cd samples/sample1-tutorial
pnpm install
pnpm run example
pnpm run cleanup

cd ../sample2-practical
pnpm run example
```

`pnpm run info` (both samples) prints the effective `mt.json` with secrets masked, plus `.mt` state
sizes, run statuses and timings.

## Running manually (packed local deps)

```bash
cd samples/sample2-practical
pnpm -C ../../packages/core pack --pack-destination ./vendor
pnpm -C ../../packages/cli pack --pack-destination ./vendor
npm install --no-audit --no-fund
pnpm run runner
```
