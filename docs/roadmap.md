# Roadmap — book processing pipeline (sample2-practical)

Book-flow plan for `samples/sample2-practical` (EN→RU over `books/book2`, 21 chapters). Task state
lives on the board (`docs/kanban.md`, machine-mutated by `at kanban`); this file maps the pipeline
steps to board rows and keeps the anchors other files cite (`step 8`, `step 9`, `R4`,
`§Request budget`) resolvable.

Flow: `books/book2 → stats → split → summary → ner → vocabulary → glossary → glossary-index →
quality → (preprocess) → titles → chapters → assemble`

Phases: `normalization` (`pipelines/normalization.ts`) → `preparation`
(`pipelines/preparation.ts`) → `translation` (`pipelines/translation.ts`).

## Legend

| Column | Meaning |
|---|---|
| Step | Stable id — code and docs cite it (`translation-stage.ts` → step 8/9, `lib/vocab.ts` → R4) |
| Stage | Pipeline stage and the files that implement it |
| Status | `Shipped` on `main` with a green gate · `Partial` shipped, a measured defect is still open · `Unmerged` done on a branch, not on `main` · `Open` board row not started |
| Gate | The check that closes the row |
| Board | `at` kanban rows — `at kanban show T###` |
| Evidence | Where it lives in the tree |

Rules of the road:

- The board is authoritative: move a row with `at kanban status T### Done`, then update this table.
  `docs/kanban.md` is never hand-edited.
- Gate for every step: `pnpm lint && pnpm typecheck && pnpm test --filter=sample2-practical`;
  `pnpm ci:local` before any FF-merge. `pnpm test:gpu` is reported, never assumed — it is RED while
  the GPU box reloads the model per request (T246).
- Steps that touch `packages/` use a worktree + branch; sample-only steps stay on the current branch.
- Free models only: every real backend uses an OpenRouter id ending `:free`; `MT_ALLOW_PAID=1` is
  the deliberate escape hatch. Keys live in the vault entry `openrouter-loop` — never read, print or
  commit a key, never re-create `docs/ideas/openrouter-key.json`.

## Pipeline steps

| Step | Stage | Status | Gate | Board | Evidence |
|---|---|---|---|---|---|
| 1 | Free-model guard + model probe | Shipped · gap T249 | `tests/llm-guard.test.ts` rejects a paid id and a silent `mock` backend; `check-llm` prints one probed row per stage model | T249 | `lib/llm.ts`, `check-llm.ts` |
| 2 | Stats (chapter size) | Shipped | `schema/stats.json`: 21 rows, `oversize: []`, mean/median/threshold | — | `pipelines/normalization.ts` (`stats`), `lib/stats.ts`, `tests/stats.test.ts` |
| 3 | Summary fix (G1) | Shipped | `tests/summary.test.ts`: 21 non-empty, distinct bullet blocks | — | `pipelines/preparation.ts` (`summary`), `f4cd37f` |
| 4 | Split + stable ids (G4) | Shipped · path unexercised | book2 ⇒ identity `chapter-map.json`; 3× fixture ⇒ `oversize:[21]`, ≥2 parts, byte-identical rerun | T240 | `pipelines/normalization.ts` (`split`), `lib/split-map.ts`, `tests/split.test.ts` |
| 5 | Quality gate (G7) | Shipped · calibration open | book2 ⇒ `translate`; dirty fixture ⇒ `preprocess` with named `reasons[]`; `quality.json` stable-ordered | T238 | `lib/quality.ts`, `pipelines/preparation.ts` (`quality`), `tests/quality.test.ts` |
| 6 | NER | Shipped · descriptions empty | mock run writes `entities.json` + 21 per-chapter files, every entity `count>=1`, ≤8 scripted calls | T236 | `pipelines/preparation.ts` (`ner`), `lib/ner.ts`, `tests/ner.test.ts` |
| 7 | Vocabulary (G6) | Shipped · noise open | 4-grams present, every term has `chapters[]`, second run identical bytes, LLM counter = 0 | T237 | `pipelines/preparation.ts` (`vocabulary`), `lib/vocab.ts`, `tests/vocabulary.test.ts` |
| 8 | Prompt slots (G3) | Shipped · priorTerms unmeasured | prompt tests green (present/absent/strict); entity+vocab blocks land between glossary and summary | T254, T265 | `packages/tools/src/normalization/translation-prompt.ts`, `tests/translate-chapters.test.ts` |
| 9 | Block translation (G2) | Shipped · defaults wrong · retune unmerged | mock run ≤30 calls for 21 chapters; `pnpm run lint:parity` clean; a dropped id falls back per line | T233, T248, T251, T252, T263 | `packages/tools/src/normalization/translation-stage.ts`, `pipelines/translation.ts` (`translateChapters`) |
| 10 | Preprocess branch | Shipped · never run on real data | `MT_FORCE_BRANCH=preprocess` writes `chapters/clean/` with equal line counts and digit multisets; verdict `translate` ⇒ 0 calls | T239 | `pipelines/preparation.ts` (`preprocess`), `lib/preprocess.ts`, `tests/preprocess.test.ts` |
| 11 | Wire + docs + `docs/SKILL.md` drift | Partial | `pnpm --filter sample2-practical run runner` (mock) exits 0 with all artefacts; `pnpm ci:local` green | T213, T231, T232, T254, T255 | `scripts/run-book.ts`, `docs/guiding/samples.md` |
| 12 | Free run, chapter-narrowed (1,2) | Shipped · smoke gate open | `check-llm` green first; `chapters/ru/chapter1.md` + `2.md`; `lint:parity` clean; ≤10 requests; no paid id | T244 | `samples/sample2-practical/reports/compare-*.md` |
| 13 | Full book across days | Partial | forced 429 stop ⇒ re-run makes 0 repeat calls for finished chapters; `chapters/book/` assembled; total ≤ budget | T241, T242, T243, T245, T261, T262, T264 | `chapters/book/book.md` (733 lines, 14 712 words) |

## Landed since the last roadmap rewrite

| Board | What landed | Where |
|---|---|---|
| T230 | Events-bus gates: lint/test green, `ci:local` GREEN, `build:bin` + `smoke` GREEN, `test:gpu` RED on server latency | `08af9dc` |
| T233 | Block-size retune: 40 drifts on free models, 6 is clean | branch `feat/t233` (`e826de9`) — **not on `main`** |
| T234 | `mt run` loses the project `.mt/vault.json` (project root = sample dir) | `7059e1b` |
| T235 | Free-tier flow fixes split into reviewable commits | `4114d1d`, `f4cd37f`, `abef859`, `b66d0e6` |

## Open board work — book flow

| Board | Pri | Issue | Plan | Step |
|---|---|---|---|---|
| T248 | High | Title batch: reasoning eats the 2048-token budget, chapter titles come back empty | — | 9 |
| T249 | High | Config `llm.use` outranks `MT_LLM_TOOL`, so a run silently hits a paid router | — | 1 |
| T261 | High | Two live runs overwrite each other's chapters — no run lock | `docs/plans/T261-run-lock-two-live-runs-silently-overwrit.md` | 13 |
| T262 | High | LLM cache key must include backend + model | `docs/plans/T262-llm-cache-key-must-include-backend-and-m.md` | 13 |
| T213 | Medium | sample2 intermediate: share one pipeline run, raise exec timeout | — | 11 |
| T236 | Medium | NER entity descriptions empty under `enrich:false` (slot pins spelling only) | `docs/plans/T236-ner-entity-descriptions-empty-under-enri.md` | 6 |
| T237 | Medium | Vocabulary: fold possessives, merge aliases, tighten proper/rare-repeat | `docs/plans/T237-vocabulary-fold-possessives-merge-aliase.md` | 7 |
| T238 | Medium | Quality gate: calibrate against a genuinely bad book (fixture matrix) | `docs/plans/T238-quality-gate-calibrate-against-a-genuine.md` | 5 |
| T239 | Medium | Preprocess branch never run end-to-end on real data | `docs/plans/T239-preprocess-branch-never-run-end-to-end-o.md` | 10 |
| T240 | Medium | Chapter split path unexercised: book2 has no oversize chapter | `docs/plans/T240-chapter-split-path-unexercised-book2-has.md` | 4 |
| T241 | Medium | `lint:parity` cannot verify a book translated straight from `books/book2` | `docs/plans/T241-lint-parity-cannot-verify-a-book-transla.md` | 13 |
| T246 | Medium | GPU box borispc3 ~80 s per chat request vs 30 s IT timeout | — | gates |
| T247 | Medium | `ChapterBody.terms()`: expose the parsed `<terms>` table | `docs/plans/chapter-terms-api.md` | 9 |
| T250 | Medium | Eval fixtures: two-paragraph narration→dialogue that catch a merged line | — | 9 |
| T251 | Medium | `cleanTranslation`: an unclosed `<terms>` silently deletes the rest | — | 9 |
| T252 | Medium | Glossary/termConsistency scoring misses inflected forms | — | 9 |
| T253 | Medium | Eval fixtures: long chapters (10–17 lines), one 400+ char line | — | 9 |
| T263 | Medium | Translate defaults (block 40, concurrency 1, terms on) contradict the measured best (6 / 3 / off) | `docs/plans/T263-translate-defaults-contradict-the-measur.md` | 9 |
| T264 | Medium | `cleanup` script must refuse while a run is live and require `--force` | `docs/plans/T264-cleanup-script-must-refuse-while-a-run-i.md` | 13 |
| T265 | Medium | Eval: prove the `priorTermsBlock` actually reduces name drift | `docs/plans/T265-eval-prove-the-priortermsblock-actually-.md` | 8 |
| T231 | Low | Lint: 3 biome errors in tools after the constants rollout | — | 11 |
| T232 | Low | router vault-secrets arch test red: sample2 `.gitkeep` ENOENT | — | 11 |
| T242 | Low | Per-stage LLM request accounting for quota planning | `docs/plans/T242-per-stage-llm-request-accounting-for-quo.md` | 13 |
| T243 | Low | Free-tier quota guard before a long book run | `docs/plans/T243-free-tier-quota-guard-before-a-long-book.md` | 13 |
| T244 | Low | Opt-in real-model smoke gate (1 chapter) against mock-only blind spots | `docs/plans/T244-opt-in-real-model-smoke-gate-1-chapter-a.md` | 12 |
| T245 | Low | Assert `book.md` frontmatter `wordCount` against the assembled chapters | `docs/plans/T245-assert-book-md-frontmatter-wordcount-aga.md` | 13 |
| T254 | Low | Document `MT_TRANSLATE_TERMS` and cover every prompt caller with a switch test | — | 8, 11 |
| T255 | Low | Sample `md://` path resolution breaks on a copied sample | — | 11 |

## New initiative — scored candidates

Same prompt to N candidates, score them, keep the winner. Off by default (`MT_SCORED=1`).

| Board | Pri | What | Plan |
|---|---|---|---|
| T256 | High | Scorer core: hard gates + soft heuristics + `pickBest` + per-call candidate report | `docs/plans/T256-scored-candidates-scorer-core-heuristics.md` |
| T257 | High | Fan-out wrapper behind `MT_SCORED=1` | `docs/plans/T257-scored-candidates-fan-out-wrapper-behind.md` |
| T258 | Medium | Config surface `llm.candidates.<stage>` + `check-llm` | `docs/plans/T258-scored-candidates-config-surface-llm-can.md` |
| T259 | Medium | Export chosen/rejected pairs for SFT and DPO | `docs/plans/T259-scored-candidates-export-chosen-rejected.md` |
| T260 | Low | Experimental router + remote ollama `machinum:4b` profile | `docs/plans/T260-scored-candidates-experimental-router-re.md` |

## Run knobs

| Knob | Default | Meaning |
|---|---|---|
| `MT_LLM_TOOL` | `mock` (offline) | backend — `router` for real runs |
| `MT_LLM_USE` | — | `vault://openrouter-loop/<id>` credential set; config `llm.use` currently outranks the env (T249) |
| `MT_LLM_MODEL_<STAGE>` | per `mt.local.json` | per-stage model override (`SUMMARY`, `NER`, `PREPROCESS`, `TRANSLATE`) |
| `MT_ALLOW_PAID` | unset | `1` = deliberate paid run (the only way past the `:free` guard) |
| `MT_ALLOW_MOCK` | unset | `1` = deliberate offline run (the only way past the mock guard) |
| `MT_TRANSLATE_SLOTS` | all four | `summary,glossary,ner,vocab` |
| `MT_TRANSLATE_SLOTS_STRICT` | unset | `1` = a missing slot artefact throws instead of warning |
| `MT_TRANSLATE_BLOCK_LINES` | 6 | body lines per request — measured best is 6 (T233/T263) |
| `MT_TRANSLATE_MAX_TOKENS` | 2048 (cap 8192) | per-request output budget |
| `MT_TRANSLATE_TERMS` | on | ask the model for the `<terms>` table — undocumented (T254) |
| `MT_PRIOR_TERMS` | on | `=0` disables the prior-terms block — unmeasured (T265) |
| `MT_PRIOR_TERMS_MAX` | 40 | cap on the injected prior terms |
| `MT_ONLY_CHAPTERS` | all | `1,2` narrows every stage |
| `MT_FORCE_BRANCH` | verdict | `translate` \| `preprocess` overrides the quality gate |
| `MT_LLM_CACHE` | off | `MT_LLM_CACHE=1` (or `llm.cache:true` in `mt.local.json`) — keeps a 429 stop resumable at zero cost |

## Request budget (book2, 21 chapters, 17.4k words)

| Stage | clean | preprocess | measured (free tier, 2026-11-14) |
|---|---|---|---|
| 1 stats/split, 4 vocabulary, 6 gate | 0 | 0 | 0 |
| 2 summary | ≈21 | ≈21 | ≈21 |
| 3 NER | 1–8 | 1–8 | 1–8 |
| 6b typo/gender | 0 | ≈21–42 | skipped — verdict `translate` |
| 7 translate (block mode) | ≈26 | ≈26 | ≈26 (block 6 ⇒ 3 requests per 16-line chapter) |
| titles | ≈5 | ≈5 | ≈5 |
| **total** | **≈55–65** | **≈100–110** | **≈129 incl. retries** |
| rejected baseline: per-line translate | ≈310 | ≈310 | ≈310 |

Measured best config (T263): block 6, concurrency 3, `MT_TRANSLATE_TERMS=off` — 649 s against
1581 s for the shipped defaults. Keep `MT_LLM_CACHE=1` so a quota stop is resumable.

## Design inputs (verified facts the plan depends on)

| Fact | Evidence |
|---|---|
| `named-entity-recognizer` is heuristic/compromise/OpenNLP, **not** LLM; LLM NER = `createEntitiesTool` + the LLM glossary extractor | `packages/tools/src/normalization/named-entity-recognizer.ts:15-20,342`, `normalization/schema/entities.ts:119` |
| Glossary corpus is truncated to 12k chars, book2 is 92k ⇒ default shrink mode sees ~13 % of the book; NER/glossary need `chunkMode:'auto'` | `packages/core/src/constants.ts:53`, `normalization/glossary-llm.ts:169-175` |
| LLM reply cache is off by default; resume after a quota stop needs it on | `packages/tools/src/core/llm-config.ts:147,169,390` |
| The DSL has no conditional branch (`fork` runs all branches) ⇒ the branch decision is data (`quality.json`) consumed by `lib/input.ts` | `packages/core/src/dsl.ts:453,470`, `docs/steering/core.md:209-210` |
| `stat-freq` already does offline n-gram counting (`maxNgram`, top-K, min word length) — the vocabulary stage is CPU-only | `normalization/stat-freq.ts:41,78-96,208,297` |
| On LLM failure `createSummaryTool` falls back to the whole chapter body (silent garbage) | `normalization/schema/summary.ts:~120` |

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

## Free-model probe (2026-11-13)

| Result | Models |
|---|---|
| answer in `content` | `nvidia/nemotron-3-ultra-550b-a55b:free`, `particle-ai/particle-1:free`, `cohere/north-mini-code:free` |
| `content` empty, `reasoning` filled at `max_tokens=40` (thinking models — need a larger budget and a probe before use) | `baidu/ernie-5.5-flash-preview:free`, `dots-studio/dots-3-note-preview:free`, `nvidia/nemotron-3.5-super-vl:free`, `nvidia/nemotron-3.5-lightning:free`, `recursive/flint-v1.0:free`, `apodex/apodex-1.1-mini:free`, `liquid/lfm-3-1.7b:free`, `liquid/lfm-2.5-2.6b:free`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` |
| unusable | `google/gemma-4-31b-it:free`, `google/gemma-4-26b-a4b-it:free` (429 provider), `thinkingmachines/inkling-2-small:free` (403, agentic harnesses only) |

## Open questions

| Question | Why it matters | Where it lands |
|---|---|---|
| Free-tier daily ceiling for this account | the budget table assumes 50/day worst case | T243 |
| Whether the LLM path honours `Retry-After` (`packages/tools/src/core/http-retry.ts` exists; usage in `llm-client` unconfirmed) | quota stops decide whether a day of work resumes or restarts | T242 |
| Title translator request count per book (batch size 5 in `translate-chapters.ts:68`) | the title batch already loses its budget to reasoning | T248 |
| Semantics of `chapterNumberOf` for non-integer chapter ids after the split | integer-keyed tooling must keep working | T240 |
| Does the `<terms>` table reduce name drift? | the slot is wired but unmeasured | T265 |
