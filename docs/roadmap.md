# Roadmap — book processing pipeline (sample2-practical)

Status: active. Started 2026-11-13. Owner: controller (Hermes) + `at` agents; design reviewed by
`claude -p --permission-mode plan` (plan kept outside the repo, summary in §Design inputs).
Source of truth for *what* to build; execution log lives in the loop journal, not here.

## Goal

Turn `samples/sample2-practical` into a real book-processing flow over `books/book2`:

1. chapter-size statistics and splitting of chapters larger than 1.5× the mean;
2. bullet summary per chapter (LLM);
3. NER — LLM extraction of main entities (characters, places, organisations, assets) per chapter and
   book-wide, with aliases and first appearance (priority 1 of the analysis stages);
4. vocabulary — statistical 4/3/2/1-gram keyword extraction, no LLM (priority 2);
5. **no diagram stage** (deferred);
6. quality gate → branch: well-written book ⇒ translation; poor book ⇒ preprocessing (typo fix,
   proofreading, gender/sex normalisation of main characters) ⇒ translation;
7. translation with slots: summary, NER, vocabulary (and glossary) injected as prompt context.

Constraint: **reuse the existing tools**; new `Tool` definitions in `packages/` are a last resort.
Two edits to existing library code are planned (`translateTaggedChapter` block mode, two new prompt
vars) — everything else is sample-local glue (`samples/sample2-practical/lib/*.ts`).

## Hard budget rule: free models only

The GPU box is unavailable and the budget is minimal. Every stage runs on OpenRouter ids ending in
`:free` (price 0). Credentials live in the vault entry `openrouter-loop`; a run selects them with:

```bash
MT_LLM_TOOL=router MT_LLM_USE=vault://openrouter-loop/<free-model-id>
```

Never read, print or commit a key; never re-create `docs/ideas/openrouter-key.json`.

Probe of the 15 `:free` models available on 2026-11-13 (one tiny Russian request each):

| Result | Models |
|---|---|
| answer in `content` | `nvidia/nemotron-3-ultra-550b-a55b:free`, `particle-ai/particle-1:free`, `cohere/north-mini-code:free` |
| `content` empty, `reasoning` filled at `max_tokens=40` (thinking models — need a larger budget and a probe before use) | `baidu/ernie-5.5-flash-preview:free`, `dots-studio/dots-3-note-preview:free`, `nvidia/nemotron-3.5-super-vl:free`, `nvidia/nemotron-3.5-lightning:free`, `recursive/flint-v1.0:free`, `apodex/apodex-1.1-mini:free`, `liquid/lfm-3-1.7b:free`, `liquid/lfm-2.5-2.6b:free`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` |
| unusable | `google/gemma-4-31b-it:free`, `google/gemma-4-26b-a4b-it:free` (429 provider), `thinkingmachines/inkling-2-small:free` (403, agentic harnesses only) |

The binding limit is the free-tier **request quota**, not money: a per-line translation design costs
~310 calls for book2 and is a defect. Target ≈55–65 calls for the clean branch and ≈100–110 with
preprocessing (see §Request budget).

## Design inputs (verified facts the plan depends on)

| Fact | Evidence |
|---|---|
| `named-entity-recognizer` is heuristic/compromise/OpenNLP, **not** LLM; LLM NER = `createEntitiesTool` + the LLM glossary extractor | `packages/tools/src/normalization/named-entity-recognizer.ts:15-20,342`, `normalization/schema/entities.ts:119` |
| Glossary corpus is truncated to 12k chars, book2 is 92k ⇒ default shrink mode sees ~13 % of the book; NER/glossary need `chunkMode:'auto'` | `packages/core/src/constants.ts:53`, `normalization/glossary-llm.ts:169-175` |
| LLM reply cache is off by default; resume after a quota stop needs it on | `packages/tools/src/core/llm-config.ts:147,169,390` |
| The DSL has no conditional branch (`fork` runs all branches) ⇒ the branch decision is data (`quality.json`) consumed by `lib/input.ts` | `packages/core/src/dsl.ts:453,470`, `docs/steering/core.md:209-210` |
| Body translation is one LLM call per non-blank line (~310 for book2) | `normalization/translation-stage.ts:215-266` |
| Suspected bug: `pipelines/summary.ts` uses `createSummaryTool` but `writeSummaries` reads `summaryByItem` ⇒ real-LLM summaries may be empty | `samples/sample2-practical/pipelines/summary.ts:24-33`, `samples/sample2-practical/lib/outputs.ts`, `normalization/heuristic-summary.ts:100`, `normalization/llm-summary.ts:34` |
| On LLM failure `createSummaryTool` falls back to the whole chapter body (silent garbage) | `normalization/schema/summary.ts:~120` |
| The series splitter keeps the same chapter `number` on every part ⇒ id collisions | `normalization/text-splitter.ts:~239` |
| `router` defaults to the paid `openai/gpt-4o-mini` when no model is set ⇒ an unset model silently spends money | `packages/tools/src/core/llm-picker.ts:~49` |
| `stat-freq` already does offline n-gram counting (`maxNgram`, top-K, min word length) — the vocabulary stage is CPU-only | `normalization/stat-freq.ts:41,78-96,208,297` |

## Flow

```text
books/book2
  → 1 stats + split            chapters/split + schema/stats.json + schema/chapter-map.json   (0 req)
  → 2 summary                  schema/chapter<N>.summary.md                                 (≈21 req)
  → 3 NER                      schema/entities.json + schema/chapter<N>.entities.json       (1–8 req)
  → 4 vocabulary               schema/vocabulary.json                                       (0 req)
  → 6 quality gate             schema/quality.json  ── verdict ─┐                            (0 req)
                                                              ├ translate  → 7
                                                              └ preprocess → chapters/clean → 7
  → 7 translate with slots     chapters/ru/chapter<N>.md + titles.json                     (≈26 req)
  → 8 assemble                 chapters/book/
```

Artefacts live under `samples/sample2-practical/chapters/` only; `.mt/` holds run state. Stage files
follow the existing pipeline pattern (`pipelines/glossary.ts:36-56`).

## Stages

### 1. Stats + series split — `pipelines/stats.ts`, `pipelines/split.ts`, `lib/stats.ts`, `lib/split-map.ts`

Tools: `chapterIndexer`, `wordCounter`, `tokenCounterBatchCached`, `createSeriesSplitTool`.
`stats.json`: `{version, unit:"bodyChars", factor:1.5, book:{chapters,totalWords,totalTokens,mean,median,threshold}, chapters:[{n,id,words,bodyChars,tokens,ratioToMean,oversize}], oversize:[n…]}`.
Rule: `threshold = 1.5 × meanBodyChars`; oversize chapters are split with
`createSeriesSplitTool({targetChars: floor(threshold)})`. Because the splitter reuses `number`, glue
renumbers the whole book sequentially and writes `chapter-map.json` (`{ "<id>": {orig, part, of} }`),
so integer-keyed tooling keeps working. book2 ⇒ identity map, zero splits; a synthetic 3× chapter
proves the rule.

### 2. Summary — `pipelines/summary.ts` (exists; fix first)

`createSummaryTool` (or `createLlmSummaryWithFallback`), out `schema/chapter<N>.summary.md` — a
`## Summary` heading followed by dash-bulleted lines, which the translator already loads as context.
Fix G1 before trusting any output.

### 3. NER — `pipelines/ner.ts`, `lib/ner.ts`

Book-wide LLM pass: `createGlossaryExtractor({chunkMode:'auto', minCount:2, relations:false, enrich:false})`;
per-chapter projection with `compileTermMatcher`/`countTerms` (0 requests); terms with `count==0` are
dropped (anti-hallucination). `GlossaryTermType` has no `organization`: glue maps `item`→asset and
`term`+description match→organisation (no core type change). Out `schema/entities.json` +
`schema/chapter<N>.entities.json`, ordered kind → `-count` → name.

### 4. Vocabulary — `pipelines/vocabulary.ts`, `lib/vocab.ts`

`defineStatFreq({maxNgram:4, minWordLen:3, topK:2000})` for the book plus `buildStatFreqReport` per
chapter; `defineStatDict` only for candidate ranking. Glue adds what `StatFreqNgram` lacks:
`chapters[]`, `df`, `capRatio` (proper-noun signal), and a phrase filter against top-100 unigrams.
No LLM.

### 6. Quality gate — `lib/quality.ts`, `pipelines/quality.ts`

Computed on the EN source, offline: typo density (`typoFinder`, glossary names subtracted),
control/zero-width chars (`forbiddenCharDetector`), structure (`chapterValidator`), metadata/markup
leaks (regex), foreign-script ratio, dialogue-quote integrity, token/word ratio, size outlier.
Verdict `translate` iff ≥90 % chapters pass and no chapter fails a hard signal, else `preprocess`.
Written to `schema/quality.json`; `lib/input.ts bookSource()` reads it (`MT_FORCE_BRANCH` overrides).
Thresholds are calibrated against book2 (`translate`) and a synthetic dirty copy (`preprocess`).

### 7. Translate with slots — `pipelines/translate-chapters.ts` (exists), `translation-prompt.ts`, `translate.system.md`

Body translation goes per **block** (chapter-sized, cap 40 lines) with per-line fallback for lines
that fail parity — this is the quota fix. Slots: `{{{entityBlock}}}` and `{{{vocabBlock}}}` are added
next to the existing `glossaryBlock`/`summaryBlock`; `MT_TRANSLATE_SLOTS` selects a subset, missing
slot files degrade to `''` with one `[WARN]` line (strict mode throws). Budget per request:
summary ≤1200 chars, entities ≤1500, vocab ≤800. Out `chapters/ru/chapter<N>.md`, `titles.json`.

### 6b. Preprocess (branch B) — `pipelines/preprocess.ts`

Only chapters that failed the gate: `createLlmTypoFix({chunkMode:'auto'})` for typos/proofreading and a
gender/sex normalisation prompt that pins pronouns from `genderTimeline`/`ruGrammar` for glossary
`character` terms. Line-count-changing replies are rejected and the original kept. Out
`chapters/clean/chapter<N>.md` + `schema/preprocess-report.json` (`digitsEqual`, `linesChanged`).

## Request budget (book2, 21 chapters, 17.4k words)

| Stage | clean | preprocess |
|---|---|---|
| 1 stats/split, 4 vocabulary, 6 gate | 0 | 0 |
| 2 summary | ≈21 | ≈21 |
| 3 NER | 1–8 | 1–8 |
| 6b typo/gender | 0 | ≈21–42 |
| 7 translate (block mode) | ≈26 | ≈26 |
| **total** | **≈55–65** | **≈100–110** |
| (rejected baseline: per-line translate) | ≈340 | ≈340 |

Narrow any run with `MT_ONLY_CHAPTERS=1,2`; keep `MT_LLM_CACHE=1` so a 429 stop is resumable at zero
cost; `concurrency:1` for the free-tier RPM.

## Model selection

`lib/llm.ts` already resolves `MT_LLM_MODEL_<TOOL>` → `settings["llm.model.<tool>"]` → `MT_LLM_MODEL`,
keyed by pipe name (`pickFor('summary')`, `'ner'`, `'preprocess'`, `'translate'`). Add a guard:
non-`mock` backends must use a `:free` id unless `MT_ALLOW_PAID=1`. `check-llm.ts` is extended to
list `:free` ids and probe each configured stage model with `max_tokens ≥ 512`, requiring non-empty
`content` — thinking models that only fill `reasoning` must fail the probe, not the pipeline.

## Roadmap steps

Gate for every step: `pnpm lint && pnpm typecheck && pnpm test --filter=sample2-practical`;
`pnpm ci:local` before any FF-merge. `pnpm test:gpu` cannot run while the GPU box is unavailable —
report it as not run, never as a pass. Steps that touch `packages/` use a worktree+branch; sample-only
steps stay on the current branch.

| # | Step | Done when |
|---|---|---|
| 1 | Free guard + model probe (G5, G8): `lib/llm.ts` `:free` guard, `mt.json` `llm.cache:true`, extend `check-llm.ts` | `vitest run tests/check-llm.test.ts` green incl. "rejects `openai/gpt-4o-mini`"; `check-llm` prints one passing row per stage model |
| 2 | Stats stage (G-stats) | `mt run ./pipelines/stats.ts` writes `schema/stats.json` with 21 rows, `oversize: []`, mean/median; test asserts max `ratioToMean < 1.5` |
| 3 | Summary fix (G1), failing test first | `tests/summary.test.ts`: 21 non-empty distinct bullet blocks under a scripted mock |
| 4 | Split + stable ids (G4) | book2 ⇒ identity `chapter-map.json`, 0 splits; 3× fixture ⇒ `oversize:[21]`, ≥2 parts, contiguous ids, rerun byte-identical (sha256) |
| 5 | Quality gate (G7) + calibration fixtures | book2 ⇒ `translate`; dirty fixture ⇒ `preprocess` with named `reasons[]`; `quality.json` stable-ordered |
| 6 | NER stage | mock run writes `entities.json` + 21 per-chapter files; every entity `count>=1`; scripted calls ≤8 |
| 7 | Vocabulary stage (G6) | 4-grams present, every term has `chapters[]`, second run identical bytes, LLM call counter = 0 |
| 8 | Slots in the prompt (G3) | prompt unit tests green (present/absent/strict); `MT_TRANSLATE_PROMPT_LOG` shows entity+vocab blocks between glossary and summary; prompt-linter green |
| 9 | Block translation (G2) | mock run ≤30 LLM calls for 21 chapters; `pnpm run lint:parity` clean; dropped-id reply triggers per-line fallback for exactly that line |
| 10 | Preprocess branch | `MT_FORCE_BRANCH=preprocess` writes `chapters/clean/` with equal line counts and digit multisets; verdict `translate` ⇒ 0 LLM calls |
| 11 | Wire + docs + `docs/SKILL.md` drift | `pnpm --filter sample2-practical run runner` (mock) exits 0 with all artefacts; `pnpm ci:local` green |
| 12 | OpenRouter free run, chapter-narrowed (1,2) | `check-llm` green first; `chapters/ru/chapter1.md`+`2.md`, `lint:parity` clean, ≤10 requests in the log, no paid id |
| 13 | Full book across days | after a forced 429 stop, re-run makes 0 repeat calls for finished chapters; `chapters/book/` assembled; total ≤ budget table |

## Risks → cheap assertions

| # | Risk | Assertion |
|---|---|---|
| R1 | Parity linter checks counts, not meaning | per block: digit multiset EN ⊆ RU, glossary names map to the pinned form; fail ⇒ per-line fallback |
| R2 | Chunking eats numerals / splits dialogue | digit multiset of chunk-joined text = input; `digitsEqual:true` in the preprocess report |
| R3 | NER hallucinated entities | drop `count==0`; test asserts every entity string occurs in ≥1 chapter |
| R4 | n-gram noise | phrase filter vs top-100 unigrams; no term starts/ends with a stopword; deterministic ordering |
| R5 | Thinking model returns empty/truncated `content` | retry on `finishReason:'length'`; cache skips empty replies; `check-llm` probes with ≥512 tokens |
| R6 | Summary silently = whole chapter or empty | summary ≤25 % of body words and ≥3 bullets, else stage fails |
| R7 | Slot text leaks into the translation | `lintLineParity` + assert no `Named entities`/`Recurring terms` literal in `ru/*.md` |
| R8 | `<terms>` report block breaks xml block replies | `cleanTranslation` before parse; unit test with the report appended |
| R9 | Paid model reachable by default | `:free` guard + test; every run log line prints `model=…:free` |
| R10 | Quota stop leaves a half-written `ru/` | checkpoints + cache; `assemble` exits non-zero unless all 21 `ru/chapter*.md` exist |
| R11 | Renumbering desyncs titles/glossary `firstChapter` | `chapter-map.json` round-trip test; `assemble` sorts by id |
| R12 | `typoFinder` flags proper nouns ⇒ false `preprocess` | subtract glossary/NER names; calibrate on the dirty fixture |

## Open questions (to settle while executing, not before)

- Free-tier daily ceiling for this account (probe with a counted run; the budget table assumes 50/day
  worst case, 1000/day with ≥$10 credit).
- Whether the LLM path honours `Retry-After` (`packages/tools/src/core/http-retry.ts` exists; usage in
  `llm-client` unconfirmed).
- Title translator request count per book (batch size 5 in `translate-chapters.ts:68`).
- Semantics of `chapterNumberOf` for non-integer chapter ids after the split.

## Status — book2 end-to-end, free tier

Measured on `books/book2` (21 chapters) with `particle-ai/particle-1:free` (zero cost):

- stages 1-11 run in one chain: `en → stats → split → summary → ner → vocabulary → quality →
  preprocess → titles → chapters → assemble`, rc=0, 11 pipelines;
- translation: block mode with `MT_TRANSLATE_BLOCK_LINES=6`, 3 requests per 16-line chapter,
  `fallbackLines=0`; the whole book took ~129 LLM requests including summaries, titles and retries
  (per-line mode would have been ~310 for the body alone);
- `lint:parity`: **21/21 chapters**, 1:1 line mapping, Cyrillic ratio 0.99-1.00, 0 errors;
- `chapters/book/book.md`: 733 lines, 14 712 words, Russian table of contents;
- quality gate verdict `translate` (passRate 1, no hard signals), so the preprocess branch correctly
  skipped; it is exercised only via `MT_FORCE_BRANCH=preprocess` and the dirty-fixture test.

Fixes this run forced (all in the tree, uncommitted): vault entry promoted to `~/.mt/vault.json`
(`mt run` roots the project at the sample dir), bullet summaries accepted by the summary tool,
`nemotron-3-ultra:free` dropped for NER (120 s timeout on a book-wide chunk), block replies parsed by
`<id>` instead of position.

Not covered yet: human read of the Russian book for fluency drift, vocabulary alias/possessive folding,
and the GPU gate (`pnpm test:gpu`) which cannot run while the remote box is busy.
