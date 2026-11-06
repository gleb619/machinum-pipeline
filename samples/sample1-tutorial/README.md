# sample1-tutorial — ten pipes, simple → complex

A guided tour of `mt`: every pipe is a real, runnable TypeScript module, and the ten files form a
learning ladder. It consolidates the former `sample0`–`sample5` demos: HTTP ingestion, waypoints,
multi-tool chains, subflows, batching, forks, the structure ladder, stop/resume, normalize/analyze,
line-by-line translation, the LLM tool gallery, and the secret-backend demo.

## What you will learn

| Pipe | Lesson |
|---|---|
| `pipe01-beginning.ts` | Minimal `from → use → to`; shipped tools; typed chapter trees; `statFreq`; `console://` |
| `pipe02-waypoints.ts` | `hs://` HTTP source, URI aliases (`@en`, `@ru`), a sample-owned `my-target://` scheme |
| `pipe03-tools-multitool.ts` | Long tool chain, `.batch(n)`, `.subflow(...)` composition |
| `pipe04-forks.ts` | `.fork('chapter-views', [three branches])` with isolated envelopes and per-branch files |
| `pipe05-chunks-ladder.ts` | `chunkSplit`, separator reuse, structure ladder (`chunks` → `paragraphs` → `lines` → `words` / `tokens`), series split, tree mutation |
| `pipe06-stop-resume.ts` | Ctrl-C pause, latch files, `mt resume` without duplicate JSONL lines |
| `pipe07-normalize-analyze.ts` | Raw `{key,value}` JSONL → clean markdown → summaries, glossary, relation graph, `<term>` tagging |
| `pipe08-translate-mock.ts` | Glossary-aware EN→RU titles + body, parity lint, plain/xml/properties modes, generic title/paragraph translators |
| `pipe09-llm-tools.ts` | One tiny pipeline per LLM tool (summary, notes, entities, NER, vocabulary, metadata, schema, typo-fix, glossary, statdata, stat-dict-translate, proofread) |
| `pipe10-secrets.ts` | Vault ref resolution with the built-in `embed:` backend (key length only, never the key) |

Everything runs offline: the default LLM backend is `mock`. The lorem-ipsum fixtures are generated
by `prepare-input.ts`; the HTTP pipe and the gallery use the real `books/book1` chapters.

## Directory layout

```
samples/sample1-tutorial/
├── pipelines/pipe01-…pipe10-….ts   # the lesson
├── lib/                            # fixtures, LLM pick, report/translate helpers
├── waypoints/my-target.ts          # sample-owned URI scheme
├── fixtures/                       # generated + committed glossary
├── jsonl/ chapters/                # runtime directories (generated outputs gitignored)
├── demo/embed.sh                   # pipe10 secret demo
├── prepare-input.ts
├── simulate-book1.ts               # client of pipe02's HTTP source
└── tests/                          # one test file per pipe
```

## How to run

```bash
pnpm install
pnpm run example           # prepare fixtures + run the non-interactive pipes (02 and 06 are skipped)
pnpm run runner:01         # one pipe
pnpm run runner:05
```

Pipe 02 needs two terminals:

```bash
pnpm run runner:02         # waits for POSTs on http://localhost:9877
pnpm run simulate          # posts three chapters of books/book1
```

Pipe 10:

```bash
pnpm run runner:10         # bash demo/embed.sh
```

Use a real model for any LLM pipe by setting `MT_LLM_TOOL` (`ollama` | `router` |
`openrouter-free` | `openrouter-pool`) and `MT_LLM_MODEL`. `mt.json` is the file fallback; the
gitignored `mt.local.json` (imported by `mt.json`) can hold local settings.

## How to clean up

```bash
pnpm run cleanup
```

## How the tests work

```bash
pnpm run test
```

Vitest runs with `fileParallelism: false` because the pipes share the sample directory. Every pipe
has at least one integration test; the HTTP test spawns the run and posts `books/book1` chapters,
the stop/resume test sends SIGINT and resumes, and the translation tests assert the prompt log
(`MT_TRANSLATE_PROMPT_LOG`) so glossary and summary injection are checked, not only the output.
