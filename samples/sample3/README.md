# Sample 3 — Normalize raw chapters, then analyze (summary, glossary, term tags)

Reads raw web-novel chapters (`{ key, value }` JSONL lines, `value` = `Chapter N: Title\n<body lines>`),
normalizes the text offline and writes one markdown file per chapter to `chapters/en/chapter<N>.md`.

## What you will learn

- How to map a raw record to a chapter record in a small `defineTool`.
- How to use the `textNormalizer` tool (quotes, dashes, ellipsis, invisible/stray symbols, blank
  lines, punctuation spacing; one paragraph per line, `[system messages]` kept).
- How to chain `typoFinder` and `markdownFormatter`, then emit with `mdOutputEmitter` into `@en`.
- How to plug an optional LLM typo-fix step via the sample2 `llm-picker` pattern.

## Directory layout

```
sample3/
├── pipelines/normalize.ts    # default + named export `normalizeFlow`
├── pipelines/analyze.ts      # stage 2: summaries + glossary + <term> tagging
├── pipelines/llm-picker.ts   # MT_LLM_TOOL / MT_LLM_MODEL pick (default: offline mock)
├── prepare-input.ts          # wraps raw {key,value} lines into {item} envelopes
├── jsonl/                    # raw input; generated input.jsonl is gitignored
├── chapters/{en,ru}/         # outputs (gitignored *.md)
├── chapters/schema/          # analyze: chapter<N>.summary.md
├── chapters/en-tagged/       # analyze: EN with <term id="..."> tags
├── chapters/glossary.json    # analyze: editable glossary
└── tests/{normalize,analyze}.test.ts
```

## How to run

```bash
pnpm run normalize                       # prepare-input + run (heuristics only, offline)
MT_LLM_TYPO_FIX=1 MT_LLM_TOOL=ollama pnpm run runner   # + LLM typo fix
```

`prepare-input.ts [raw.jsonl] [out.jsonl]` defaults to `jsonl/kidnapped_dragons_en_0-10.jsonl`
(your own data; not committed). The LLM step is off unless `MT_LLM_TYPO_FIX=1`; with the default
`mock` backend it echoes the text back. A reply whose line count differs is discarded.

Decorative-only lines (`***`, `~~~`) are dropped; all other lines are preserved one to one.

## Stage 2: analyze

```bash
pnpm run analyze                  # reads chapters/en/*.md (run normalize first), offline
MT_LLM_SUMMARY=1 MT_LLM_TOOL=ollama pnpm run analyze   # optional LLM summary
```

Writes, with no LLM needed:

- `chapters/schema/chapter<N>.summary.md` — heuristic summary (lead + most informative sentences).
  `MT_LLM_SUMMARY=1` asks the picked backend instead and falls back to the heuristic one.
- `chapters/glossary.json` — `{ terms: [{ id, term, type, count, firstChapter, ru, aliases }] }`
  (capitalised names, `[Bracketed]` terms, repeated capitalised nouns). Edit it by hand: fill `ru`,
  fix `type`, add `aliases`, drop noise by moving a term string into `ignored`. Re-running keeps `ru`,
  `aliases`, `type`, manual terms; only `count` / `firstChapter` are recomputed. Delete the file to
  start over.
- `chapters/en-tagged/chapter<N>.md` — EN text with `<term id="ID">text</term>` around every glossary
  term (longest match first, no nesting, code skipped, idempotent, same line count). `stripTerms()`
  from `@mt/tools` restores the original text exactly.

Tools: `heuristicSummaryTool`, `glossaryExtractor`, `termTagger` (see `docs/steering/tools.md`).

## How to clean up

```bash
pnpm run cleanup
```

## How the test works

`tests/analyze.test.ts` writes tiny synthetic chapters and checks summaries, glossary types/counts, tag
round trip (`stripTerms(tagged) === original`, same line count) and that manual `ru` edits survive a re-run.

`tests/normalize.test.ts` writes a tiny synthetic fixture to `jsonl/input.jsonl`, runs the pipeline
through `mt`, and asserts file count, preserved paragraph lines, no curly quotes / zero-width chars,
and literal `[bracketed]` text. No network, no LLM.
