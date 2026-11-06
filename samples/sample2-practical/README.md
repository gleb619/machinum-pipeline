# sample2-practical — prepare a real book translation

A practical pipeline set for translating `books/book2` (21 English chapters, *The Quiet Frequency*)
into Russian. It is the workflow you would run on a real book: extract the chapters, translate the
titles, extract a glossary, summarize each chapter for context, translate the body line by line with
parity linting, and assemble the result into one book.

The default backend is the offline `mock`, so the sample and its tests run with no credentials or
network. Switch to a real model with environment variables or `mt.local.json`.

## Pipes

| Pipe | Job |
|---|---|
| `extract-en.ts` | `books/book2` → `chapters/en/chapter<N>.md` (skips `index.md` / `plot.md`) |
| `translate-titles.ts` | batch titles of five chapters → `chapters/titles.json` |
| `glossary.ts` | cross-chapter term extraction → `chapters/glossary.json` |
| `summary.ts` | per-chapter summary → `chapters/schema/chapter<N>.summary.md` (prompt context only) |
| `translate-chapters.ts` | glossary-tagged body, one LLM call per line, summary injection, parity lint → `chapters/ru/chapter<N>.md` + `chapters/titles.json` |
| `assemble.ts` | numeric chapter sort → `bookCompiler` → `chapters/book/book.md` + `book.json` |

Order matters: `summary` and `glossary` feed the prompts of `translate-chapters`; `assemble` reads
the RU output.

## How to run

```bash
pnpm install
pnpm run example          # all pipes, offline mock backend
pnpm run runner:summary   # or one pipe
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

`lib/llm.ts` is the single backend pick (`pickLlmTool({ configPath: mt.json, mockSource })`).
Per-tool model overrides are available as `MT_LLM_MODEL_<TOOL>` or `settings["llm.model.<tool>"]`.

## Outputs

```
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

`fileParallelism: false` keeps the shared `chapters/` directory stable. Each pipe has an
integration test; the translation test runs `summary` + `glossary` first and asserts the prompt log,
line parity, titles and the standalone parity linter. Every test forces `MT_LLM_TOOL=mock`.
