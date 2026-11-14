# Samples

Two runnable samples cover the feature set. Both live in the pnpm workspace and double as
integration tests:

- `sample1-tutorial` — tutorial/showcase of the project's human-facing features: ten numbered
  pipes, fixtures, demo data. Runs against `books/book1` plus deterministic lorem-ipsum fixtures;
  it is not a real full book run.
- `sample2-practical` — the real pipeline: processes `books/book2` (21 chapters) end-to-end
  (extract, glossary, summarize, translate, `bookCompiler` → `book://`).

Deprecated samples (old `sample0`…`sample5` directories) are archived under
`samples/depricated/` for reference; they are not in the pnpm workspace and do not run in
test gates.

| Sample | Path | What it demonstrates |
|---|---|---|
| sample1-tutorial | `samples/sample1-tutorial` | Ten numbered pipes, simple → complex: `from → use → to`, HTTP source + URI aliases + a custom waypoint, multi-tool chains/subflows/batch, `.fork()` branches, chunking + the structure ladder, stop/resume, normalize + analyze (summaries/glossary/`<term>` tagging), line-by-line EN→RU translation with parity lint, the LLM tool gallery, and the secret-backend demo. Input: `books/book1` plus deterministic lorem-ipsum fixtures. |
| sample2-practical | `samples/sample2-practical` | Real book translation prep against `books/book2` (21 chapters): extract EN chapters, batch-translate titles, extract a glossary, summarize each chapter for context, translate the body line by line with parity lint, and assemble the result with `bookCompiler` → `book://`. Output under `chapters/ru/` and `chapters/book/`. |

Adding a new sample: see [adding-a-sample.md](adding-a-sample.md).

## sample2-practical book flow

`pnpm run runner` chains the whole book workflow in dependency order. Every stage writes one
artefact under `chapters/`; later stages read the earlier artefacts, so the order is part of the
contract (`split` reads `schema/stats.json`, `preprocess` reads `schema/quality.json`).

| Stage | Pipeline | Artefact | Backend |
|---|---|---|---|
| Extract EN | `pipelines/extract-en.ts` | `chapters/en/chapter<N>.md` | CPU |
| Stats | `pipelines/stats.ts` | `chapters/schema/stats.json` | CPU |
| Split | `pipelines/split.ts` | `chapters/schema/chapter-map.json` (+ `chapters/split/` only when a chapter is oversized) | CPU |
| Summary | `pipelines/summary.ts` | `chapters/schema/chapter<N>.summary.md` | LLM |
| NER | `pipelines/ner.ts` | `chapters/schema/entities.json` + `chapters/schema/chapter<N>.entities.json` | LLM |
| Vocabulary | `pipelines/vocabulary.ts` | `chapters/schema/vocabulary.json` | CPU |
| Quality gate | `pipelines/quality.ts` | `chapters/schema/quality.json` (verdict `translate` or `preprocess`) | CPU |
| Preprocess | `pipelines/preprocess.ts` | `chapters/clean/chapter<N>.md` + `chapters/schema/preprocess-report.json` | LLM (only on the `preprocess` branch; a `translate` verdict makes it a no-op) |
| Titles | `pipelines/translate-titles.ts` | `chapters/titles.json` | LLM |
| Body | `pipelines/translate-chapters.ts` | `chapters/ru/chapter<N>.md` | LLM (block mode) |
| Assemble | `pipelines/assemble.ts` | `chapters/book/book.md` + `book.json` | CPU |

Environment knobs:

- `MT_LLM_TOOL` — backend; default `mock` (offline). Real runs use `router`.
- `MT_LLM_USE=vault://openrouter-loop/<id>` — select a vault-stored credential set.
- `MT_LLM_MODEL_<STAGE>` — per-stage model override (`SUMMARY`, `NER`, `PREPROCESS`, `TRANSLATE`, …).
- `MT_TRANSLATE_SLOTS` — comma list of `summary,glossary,ner,vocab`; absent = all four.
- `MT_TRANSLATE_SLOTS_STRICT=1` — a missing slot artefact throws instead of warning.
- `MT_TRANSLATE_BLOCK_LINES` — body lines per request; default 40.
- `MT_TRANSLATE_MAX_TOKENS` — per-request output budget; default 2048, capped at 8192.
- `MT_ONLY_CHAPTERS=1,2` — narrow every stage to the listed chapters.
- `MT_FORCE_BRANCH=translate|preprocess` — override the quality verdict.

### Free-models-only budget

Real backends must use an OpenRouter id ending in `:free`; `lib/llm.ts` refuses anything else
unless `MT_ALLOW_PAID=1` is set deliberately. The binding limit is the free-tier **request
quota**, not money.

| Path | Requests for book2 (21 chapters) |
|---|---|
| summary | ≈21 |
| NER | 1–8 |
| titles | ≈5 |
| translate (block mode) | ≈26 |
| preprocess (dirty branch only) | 0 clean / ≈21–42 dirty |
| retries/overhead | ≈0–5 |
| **total (clean branch)** | **≈55–65** |
| translate (per-line mode, rejected) | ≈310 |

Keep `MT_LLM_CACHE=1` so a 429 stop resumes without re-sending finished requests. Per-line mode
costs ~310 calls for book2 and must not be used against the free tier; block mode with per-line
fallback only for failed lines is the supported path.

## Tutorial pipe map

| Pipe | Lesson |
|---|---|
| `pipe01-beginning.ts` | Minimal source → shipped tool → target; typed chapter trees; `statFreq`; `console://` |
| `pipe02-waypoints.ts` | `hs://` HTTP ingestion, `@en` / `@ru` aliases, sample-owned `my-target://` |
| `pipe03-tools-multitool.ts` | Six-tool chain, batch subflow `.subflow('batch://?size=N', pipe)`, subflow composition, `batch://` views |
| `pipe04-forks.ts` | Parallel `.fork('chapter-views', [...])` branches with isolated envelopes; plus a named-event publisher/subscriber pair (`eventsSuite`) |
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
