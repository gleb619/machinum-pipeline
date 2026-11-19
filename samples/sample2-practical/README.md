# sample2-practical — prepare a real book translation

A practical pipeline set for translating `books/book2` (21 English chapters, *The Quiet Frequency*)
into Russian. It is the workflow you would run on a real book: extract the chapters, translate the
titles, extract a glossary, summarize each chapter for context, translate the body line by line with
parity linting, and assemble the result into one book.

With no local settings the resolved backend is the offline `mock`; a deliberate mock run outside
the test suite needs `MT_ALLOW_MOCK=1`. Switch to a real model with environment variables or
`mt.local.json`.

Reusable stages (stats, split, quality gate, glossary index, vocabulary, entities, output
emitters, preprocess, batch titles, LLM picker) live in [`@mt/tools`](../../packages/tools/).
This sample keeps only `books/book2` paths, the book source, mock LLM answers and the
`MT_ALLOW_MOCK` / `MT_ALLOW_PAID` policy in `lib/`.

Each phase file ends with
`defineProcess([...], { id: 'practical-<phase>' }).install(installSampleMock())`.
`installSampleMock()` returns a `ProcessInstall` and is a no-op unless the resolved backend is
`mock`; when it is, it installs one scripted provider process-wide (`lib/mock-llm.ts`). Stage
factories resolve the backend at invoke time, so the named stage exports stay plain pipelines with
no per-stage `call` or mock callbacks.

## Pipes

Exactly three pipeline modules. Each module exports its individual stages as named pipelines and a
default process that runs them in order; the process keeps one run/checkpoint per stage.

| Phase | Entry point | Stages (named exports) |
|---|---|---|
| Normalization | `pipelines/normalization.ts` | `extractEn` → `stats` → `split` |
| Preparation | `pipelines/preparation.ts` | `summary` → `ner` → `vocabulary` → `glossary` → `glossaryIndex` → `quality` → `preprocess` |
| Translation | `pipelines/translation.ts` | `translateTitles` → `translateChapters` → `assemble` |

| Stage export | Job |
|---|---|
| `normalization.ts#extractEn` | `books/book2` → `chapters/en/chapter<N>.md` (skips `index.md` / `plot.md`) |
| `normalization.ts#stats` | measure every chapter → `chapters/schema/stats.json` |
| `normalization.ts#split` | split oversized chapters → `chapters/schema/chapter-map.json` (+ `chapters/split/`) |
| `preparation.ts#summary` | per-chapter summary → `chapters/schema/chapter<N>.summary.md` (prompt context only) |
| `preparation.ts#ner` | book entities → `chapters/schema/entities.json` + per-chapter projections |
| `preparation.ts#vocabulary` | statistical n-grams → `chapters/schema/vocabulary.json` |
| `preparation.ts#glossary` | cross-chapter term extraction → `chapters/glossary.json` |
| `preparation.ts#glossaryIndex` | project the glossary onto the chapters where it occurs |
| `preparation.ts#quality` | offline quality gate → `chapters/schema/quality.json` |
| `preparation.ts#preprocess` | conditional typo/proofread/gender pass → `chapters/clean/` |
| `translation.ts#translateTitles` | batch titles of five chapters → `chapters/titles.json` |
| `translation.ts#translateChapters` | glossary-tagged body, one LLM call per line/block, summary injection, parity lint → `chapters/ru/chapter<N>.md` |
| `translation.ts#assemble` | numeric chapter sort → `bookCompiler` → `chapters/book/book.md` + `book.json` |

Order matters: `normalization` writes the size and split artefacts; `preparation` builds the
prompt context and the translate/preprocess verdict; `translation` consumes both and assembles
the RU output. Run the phases in that order.

## How to run

```bash
pnpm install
MT_ALLOW_MOCK=1 pnpm run example   # all three phases, offline mock backend
pnpm run runner:normalization
pnpm run runner:preparation
pnpm run runner:translation
pnpm run runner:summary   # or one stage
pnpm run runner:chapters
pnpm run lint:parity      # standalone EN/RU line-parity table
pnpm run check-llm        # which backend/model the pipes will use
```

Run a subset while iterating:

```bash
MT_ONLY_CHAPTERS=1,2 pnpm run runner:chapters
MT_TRANSLATE_PROMPT_LOG=$PWD/.mt-translate-prompts.jsonl pnpm run runner:chapters
```

### Real model

```bash
# ollama on a remote GPU box
MT_LLM_TOOL=ollama \
MT_LLM_MODEL=gemma4:latest \
MT_OLLAMA_URL=http://127.0.0.1:11434/v1 \
pnpm run example

# or through the router
MT_LLM_TOOL=router MT_LLM_MODEL=openai/gpt-4o-mini pnpm run example
```

Or put the same keys in `settings` of a gitignored `mt.local.json` (imported by `mt.json`):

```json
{
  "settings": {
    "llm.tool": "ollama",
    "llm.baseUrl": "http://127.0.0.1:11434/v1",
    "llm.model": "gemma4:latest"
  }
}
```

Backend resolution happens at invoke time, first match wins: an explicit `call` / `translate`
passed to a factory, then `MT_LLM_TOOL` / mt.json naming a real backend, then the process-level
mock installed by `installSampleMock`, then the factory default. `lib/llm.ts` keeps the sample
policy over `@mt/tools`: the free-model guard (`MT_ALLOW_PAID`) and the mock guard
(`MT_ALLOW_MOCK`, relaxed under `VITEST`), plus `modelEnvVar` / `gateLayer`. The scripted answers
and the install hook live in `lib/mock-llm.ts`; both files read the same `mt.json` (with its
imported `mt.local.json`).

Per-tool model overrides are available as `MT_LLM_MODEL_<TOOL>` or `settings["llm.model.<tool>"]`.

The endpoint can also come from a vault entry (`MT_LLM_USE` / `settings.llm.use` =
`vault://<entry>[/<model>]`). `mt run` searches this directory and its ancestors up to the git
top-level, so the entry can live in the repository's `.mt/vault.json`; it does not need to be
copied to `~/.mt/`. A `samples/sample2-practical/.mt/vault.json` would override the repository one.

## Outputs

```text
chapters/
├── en/chapter<N>.md            # extracted source
├── ru/chapter<N>.md            # translated chapters
├── schema/chapter<N>.summary.md
├── titles.json                 # { "<n>": { en, ru } }
├── glossary.json               # edit by hand, re-runs keep your edits
└── book/{book.md,book.json}    # assembled book + TOC/warnings
```

## How to clean up

```bash
pnpm run cleanup
```

## How the tests work

```bash
pnpm run test
```

`fileParallelism: false` keeps the shared `chapters/` directory stable. Each phase and every
non-trivial stage has an integration test; the translation test runs `summary` + `glossary` first
and asserts the prompt log, line parity, titles and the standalone parity linter. Every test forces
`MT_LLM_TOOL=mock`; the spawned runs inherit `VITEST`, which the mock guard accepts.
