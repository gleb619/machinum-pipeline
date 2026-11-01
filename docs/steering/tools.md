# @mt/tools
← [Architecture](../guiding/architecture.md)

Path: `packages/tools/`

Chapter processing tools for validation, translation, schema extraction, and formatting. All tools are `defineTool()` instances exported from `src/index.ts`. Tools operate on `Exchange<Chapter>` or domain-specific payload types.

**Exchange contract.** A tool receives `Exchange<I>` and returns `Exchange<O>` *derived from the input*
(`withItem(ex, out)`, `setVariable(s)`, `pushVariable`) so `id`, `meta` and `variables` propagate - never
rebuild `{ item, meta }` and never `{ ...ex, item: x }` (use `withItem`: it pushes the `item` variable and keeps the previous payload as `oldItemOf(ex)`; `ex.item` is a synced copy of that variable). `meta` stays identity-only (`chapterId`, `chapterNum`, `lang`, ...); everything a
tool computes (`summary`, `tokenCount`, `glossary`, `llm` config, `mdOutputs` write intents, ...) is a
**variable** of the same name, exported as a `VAR_*` constant where the module owns it. Entries below that say
"`X` variable" are read/written with `getVariable(ex, 'X')` / `setVariable(ex, 'X', v)`; per-envelope config
variables (`llm`, `prompts`, `context`, `schemaDocLlm`) also accept the legacy `meta.<name>` as a read fallback.

**Persistence.** Put anything that must survive pause/resume/dead-letter in a variable; `meta` is in-flight
only and is not written to dead-letter entries or `jsonl://` targets. Ephemeral variables are in-flight too.

## Tool Catalogue

### `chapter-validator.ts`
- `chapterValidator` — structural markdown validation (heading hierarchy, code block languages, link integrity)
- `forbiddenCharDetector` — finds zero-width chars, forbidden control chars
- `typoFinder` — detects common Chinese/English typos, mixed scripts

### `chapter-doc.ts`
Reads/writes chapter YAML-frontmatter documents (`.chapter-doc.yml`). Internal format for passing per-chapter metadata between tools. Exports: `readChapterDoc`, `writeChapterDoc`, `chapterDoc` (composable tool: slots `build` + `emit` -> `chapters/en`).

### `schema-doc.ts` + `schema/`
LLM-powered schema document generation. The mdshape document format (`SchemaDocEnvelope`, `readDoc`,
`writeDoc`, `schemaDocWriter`) lives in `schema-doc.ts` and stays pure; the five extraction tools live in
`packages/tools/src/schema/`, one file each:

- `summary.ts` — `summaryTool` / `createSummaryTool` → `summary` variable; `notesSummaryTool` / `createNotesSummaryTool({ count })` → `summaryNotes` variable + `summary` variable (rendered `- ` bullet block). Both compose the default system prompt from the bundled `summary.system`, the global `llm.format.plain` and the `summary.output.bullets` blocks (see the prompt-block system below); the notes tool renders the bundled `summary.user` user template (see below). Both accept `SummaryChunkOptions`: `chunkMode?: 'shrink' | 'chunk' | 'auto'` (default `'shrink'`), `outputReserve`, `reserve`, `splitUnit`, and `chunkConcurrency`. When `chunkMode` is `'chunk'` or `'auto'` and the chapter body exceeds the model's per-call budget, the body is split semantically, each chunk is processed independently, and the results are merged. Chunking metadata is stored in `summaryChunks` / `summaryNotesChunks` variables.
- `entities.ts` — `entitiesTool` / `createEntitiesTool` → `entities` variable
- `schema.ts` — `schemaTool` / `createSchemaTool` → `schema` variable (mermaid)
- `metadata.ts` — `metadataTool` / `createMetadataTool` → `metadata` variable
- `vocabulary.ts` — `vocabularyTool` / `createVocabularyTool` → `vocabulary` variable, `knownWords` variable

Each calls `runPromptWithRetry` (`schema/llm.ts`), which wraps `chatCompletionSingle` from
`openrouter-tool.ts` against `ctx.run.global.routerUrl`. Shared pieces: `schema/doc.ts` (chapter parsing,
prompt rendering, CSV/table parsers, mdshape round-trip check) and `schema/llm.ts` (retry loop guard).

**Bundled prompts** (`core/bundled-prompts.ts`): `packages/tools/prompts/*.md` is compiled into
`src/generated/prompts.ts` by `scripts/gen-prompts.mjs` (wired into the package `build` / `typecheck` /
`test` scripts), so prompt texts ship inside `dist` and the single-file `mt` CLI bundle with no runtime
fs reads. `loadBundledPrompt(name)` / `listBundledPrompts()` expose them; `llm-prompts.ts` registers each
one as a prompt-registry default (`summary.system`, `summary.user`, `summary.output.bullets`, `translate.system`,
`translate.output.<mode>`, the global `llm.format.<mode>` blocks, …), overridable like any other default.
`tests/bundled-prompts.test.ts` keeps the generated module in sync with the md sources.

**Prompt-block system** (`core/prompt-blocks.ts`): the 3 work modes (`PromptWorkMode` = `'plain' | 'xml' |
'properties'`, `PROMPT_WORK_MODES`) and the mode machinery are global, shared by every LLM tool family.
`wrapPromptInput(text, mode)` wraps the unit for the user prompt (plain = bare text; xml =
`<result><id>N</id><origin>…</origin></result>` in `<context>`; properties = `N=text` in `<context>`).
`composePromptBlocks(family, mode, vars, { output? })` renders `<family>.system` + the global
`llm.format.<mode>` + `<family>.output.<mode>` (falling back to the single `<family>.output`, or an explicit
named block via `output`, e.g. `'summary.output.bullets'`) into `{ systemPrompt, userPrompt, complete }`;
`complete: false` means a block is missing and the caller falls back to a hand-built prompt.
`buildLlmPrompt(family, { text, mode, vars })` is the text-folding convenience. Structured replies are parsed
by the shared tolerant `parseStructuredReply(reply, 'xml' | 'properties', { valueTag?, unescape? })`
(numeric sort, contiguous 1..N, retryable `StructuredReplyParseError`); `extractXmlResultEntries` /
`extractPropertiesEntries` are its extraction primitives (the proofread tools reuse them with their own
`<text>` / `<proofread>` tags and properties unescaping). `translation-prompt.ts` keeps the deprecated
`TranslateWorkMode` / `TRANSLATE_WORK_MODES` / `wrapTranslationInput` aliases for compatibility.

**Loop guard:** a reply must be non-empty, parse as mdshape, and keep the section's required content (key
terms covered, entities/terms present in the chapter, diagram keyword + edges, metadata counters unchanged).
Rejections are re-prompted with the reason appended, max 3 attempts, then the deterministic fallback (the
value already in the document, else the pre-LLM heuristic) so the run never hard-fails. the `<tool>Llm` variable
records `attempts`, `tokens`, `model`, `fallbackUsed`, `lastFailure`.

**Configuration:** `create*Tool({ model, temperature, maxTokens, systemPrompt, userPrompt, maxAttempts,
routerUrl, call })`, default model `openai/gpt-4o-mini`; per-envelope overrides via `schemaDocLlm` variable and
`<key>Prompt` / `<key>SystemPrompt` variables. `call` (`SchemaDocLlmCall`: `(input, ctx) =>
Promise<ChatCompletionOutput>`) replaces the router-proxy request with a custom backend. Without `call`,
`runPromptWithRetry` consults the process-level pick (`resolveProcessLlm` — installed mock or the
`MT_LLM_TOOL` backend) before falling back to the router proxy. Templates render `{{title}}`,
`{{body}}`, `{{chapter}}`, …
Batched envelopes store per-item results in the `<key>ByItem` variable.

- `schemaDocWriter` — persists to `schema-doc://` target (pure, no LLM call)

Envelope type: `SchemaDocEnvelope`.

### `translate-text.ts`
- `translateText` / `createTranslateText(opts)` — composable translation tool (slots `prepare, fit, call,
  parse, emit`). Default `call` backend POSTs `/api/translate` on the MT router proxy (legacy behaviour and
  error messages kept); `backend: 'llm'` routes through the LLM toolkit (`resolveLlmConfig` provider,
  prompts `translate.system` / `translate.user`). Options: `TranslateTextOptions` (`targetLang`, `backend`,
  `llm`, `routerUrl`, `prompts`); legacy `TranslateToolConfig` type kept for compatibility.
  `llmTranslate` / `createLlmTranslate(options)` (`llm-translate.ts`) share this one implementation with the `llm` backend and accept the same chunk options.
  `chunkMode?: 'shrink' | 'chunk' | 'auto'` (default `'shrink'`) plus `outputReserve`, `reserve`, `splitUnit`,
  and `chunkConcurrency` enable budget-aware chunk translation: oversized text is split, translated chunk by
  chunk, and merged with paragraph separators. Chunk metadata is stored in the `translateChunks` variable.

### `core/chunk-processor.ts`
Shared budget-aware chunk processing used by every LLM tool listed under chunk-mode coverage below.

- `resolveChunkBudget({ ctx?, input?, llmConfig? })` → `ChunkBudget | null`. Computes a per-call input budget
  from the model context limit (via `modelContextLimit` / `resolveContextConfig`), requested `outputReserve`,
  reasoning reserve (`estimateReasoningReserve`), prompt `overhead`, and a safety `reserve`. Returns `null` when
  no context limit can be determined.
- `shouldChunkText(text, budget, count?)` — true when the text alone exceeds the per-chunk input budget.
- `adaptiveSemanticChunks(text, budget, { unit?, count?, overlapChars? })` — splits text into coherent chunks
  that fit the budget, falling back from paragraphs → sentences → lines → words → characters as needed.
- `processChunks({ chunks, process, merge, concurrency? })` — processes every chunk and merges the outputs.
- `processTextInChunks({ text, budget, process, merge, split?, count?, concurrency? })` — high-level helper
  that splits, processes, and merges in one call.
- `groupItemsToBudget({ items, budget, weigh, render })` — groups arbitrary items under a budget (used by the
  XML proofreader to batch `<result>` blocks).
- `withTextChunks(tool, { budget, mode?, split?, count?, concurrency?, record? })` — decorator that adds
  chunk/auto mode to any `{ text }`-in/`{ text }`-out tool. Records chunk metadata under `VAR_CHUNK_PROCESSOR`
  (`chunkProcessor` variable) when chunking runs.

Budget math: `inputBudget = contextLimit - outputReserve - thinkReserve - overhead - reserve`. Reasoning-family
models (`o1`/`o3`/`o4`, `deepseek-r1`, `qwq`, `claude-4`) reserve headroom for thinking tokens. The default mode
for every affected tool remains `'shrink'` (single call); opt into chunking with `'chunk'` or `'auto'`.

**Which mode?** `shrink` (default) - one call, the gate `fit` slot trims the prompt; cheapest, may lose text on
oversized input. `chunk` - always split to budget-sized chunks, process each, merge; most thorough, most calls.
`auto` - compute the budget first, chunk only when the text exceeds it, else one call (best general choice for
long chapters). Chunk metadata (`chunks`, `limit`, `inputBudget`, `model`) lives in a variable per tool
(see the coverage table). Merge strategies are per tool (also in the table).
`estimateOverhead(...promptParts)` and `DEFAULT_OUTPUT_RESERVE` are the single source of overhead/reserve defaults.
Token counts use tiktoken (`countTextTokens`); providers differ, so budgets are approximate (`reserve` absorbs drift).
`normalization/token-splitter.ts` is a pipeline Tool that emits chunks; `chunk-processor` is a library used inside
LLM tools - kept separate on purpose.

**Shared dispatcher.** `runChunkedText({ mode, text, budget, single, chunk, merge, splitUnit?, concurrency? })`
decides single call vs split -> process -> merge on top of `processChunks`; `resolvePromptBudget(ctx, resolved,
{ outputReserve, reserve }, promptParts)` builds the budget (overhead from the prompt parts rendered with an empty
text slot); `ChunkModeOptions` / `ChunkMode` / `toChunkRecord` are the common option and metadata shapes. Every
tool below supplies only its prompts plus a merge strategy; `proofread` / `proofread-xml` run their group XMLs
through `processChunks` directly.

**Chunk-mode coverage** (all take `ChunkModeOptions`: `chunkMode`, `outputReserve`, `reserve`, `splitUnit`,
`chunkConcurrency`; default `'shrink'`):

| Tool | Variable | Merge |
|---|---|---|
| `summary`, `summary-notes`, `llm-summary` (wraps `summary`) | `summaryChunks`, `summaryNotesChunks` | join / dedupe + cap |
| `proofread`, `proofread-xml` | `proofreadChunks`, `proofreadXmlChunks` | by id |
| `translate-text`, `llm-translate` (`createLlmTranslate(opts)`) | `translateChunks` | join in order |
| `entities` | `entitiesChunks` | dedupe by name, re-index, cap 200 |
| `vocabulary` | `vocabularyChunks` | dedupe, cap `limit` |
| `llm-typo-fix` | `llmTypoFixChunks` | join with blank line; a chunk whose reply changes its line count keeps its original text, `llmFixed` is true only when every chunk applied |
| `glossary-llm` stage A (`extractGlossaryWithLlm`) and stage C (`enrichTermWithLlm`); threaded through `glossary-extractor` options | result `chunks` field | entries merged by name (references unioned) / bullet lines deduped |
| `chapter-translator` (`createParagraphTranslator`) | `translateChunks` (from the inner translator) | default translator becomes `createTranslateText({ chunkMode, backend })` so an oversized paragraph is split; ignored when a custom `translate` is passed |

In glossary stages `shrink` keeps the historical `maxChars` truncation; `chunk`/`auto` send the full corpus sized by
the token budget. A fixed `userPrompt` override carries no corpus text, so those stages stay single-call.

**Not chunkable (left shrink-only on purpose):**
- `normalization/schema/metadata.ts` - output is one measured row (counters of the whole chapter, validated against
  ground truth); the body is not what the model produces, chunk replies could not be merged meaningfully.
- `normalization/schema/schema.ts` - output is one whole-document mermaid diagram; merging per-chunk diagrams would
  yield a different, non-faithful structure.
- `glossary-llm` stage B (`relateTermWithLlm`) - prompt is a term plus short name lists, no document text.
- `title-translator` - input is a single title line.

Translate-chunk dedupe stays out of scope (deliberate): chunks are joined in order without dedupe. The
`token-splitter` boundary is unchanged: `normalization/token-splitter.ts` is a pipeline Tool, `chunk-processor` a
library.

### `modification/proofread.ts`
- `proofreadTool` / `createProofreadTool(options)` — LLM proofreading of plain text; splits text into paragraphs,
  sends XML to the model, and reconstructs the corrected text. `proofreadXmlTool` / `createProofreadXmlTool(options)`
  is the lower-level sub-tool that accepts/returns the raw XML. `proofreadPropertiesTool` uses Java properties
  format. All support `ProofreadChunkOptions` (`chunkMode`, `outputReserve`, `reserve`, `splitUnit`,
  `chunkConcurrency`) with default `'shrink'`. In `'chunk'`/`'auto'` mode, paragraphs or XML `<result>` blocks are
  batched to fit the per-call budget and proofread concurrently on the shared `processChunks` loop; the result is reconstructed by id. Chunk metadata
  is stored in `proofreadChunks` / `proofreadXmlChunks` variables.

### `heuristic-summary.ts` / `glossary-extractor.ts` / `term-tagger.ts`
Analysis tools, all accept a single `env.item` or a batched `env.items` corpus. The glossary extractor is
offline by default and uses an LLM backend when one is given.

- `heuristicSummaryTool` / `createHeuristicSummaryTool({ sentences })` — extractive summary (lead sentence +
  highest term-frequency sentences, original order). Same variable contract as `summaryTool`: `summary`,
  `summaryByItem`, plus `heuristicSummaryByItem` (fallback for an LLM step).
- `glossaryExtractor` / `createGlossaryExtractor({ load, minCount, ignored, call, model, temperature, maxTokens,
  maxAttempts, nerBackend, relations, enrich, coOccurrence })` (T136) — candidates = capitalised multiword names,
  `[Bracketed]` short terms, repeated capitalised singles, **plus the NER candidates** (proper names and locative
  phrases, seeded by `createHeuristicNerBackend()` or a pluggable backend); type guess
  (`character|place|item|skill|term`, refined by the NER kind), `count`, `firstChapter`.
  `buildGlossary(chapters, existing)` merges into an existing glossary: existing entries keep `id/type/ru/aliases`
  and manual edits (human-added terms too), only `count/firstChapter` are recounted; the `ignored` / `rejected`
  lists are kept and `ignored` terms are never re-added. With an LLM backend (`call`, e.g.
  `pickLlmTool().schemaCall`) the corpus is analysed with the bundled
  `glossary.system` / `glossary.user` prompts: the terms of the previous glossary are **reused** (their `ru` and
  `type` win), only the new candidates are extracted, and a failed reply falls back to the heuristic glossary.
  Result in `glossary` variable / `glossaryJson` variable / `glossaryGraph` variable / `glossaryGraphJson` variable / `chapterNums` variable.
  Shape: `{ terms: [{ id, term, type, count, firstChapter, ru, aliases, pending?, references?, description? }],
  ignored?, rejected? }`.
- `mergeExtractedEntries(glossary, entries, protectedIds)` — merges the entries reported by the model: a known term
  keeps its `ru` (and its `type` when it is protected, i.e. reused from the previous glossary — locked terms are
  always protected, T140: their `ru`/`type` are final), an unknown term is appended with the reported
  type/description. Pure.
- `applyRelations(glossary, relations)` / `coOccurrenceRelations(chapters, glossary)` — relation graph of the terms:
  `term.references` holds the names of the related terms (the ones that share a sentence of the corpus, plus the
  ones the model reported). `buildGlossaryGraph(glossary)` turns them into nodes/edges, `findReferences(graph, term,
  hops)` looks the related terms up within 1..3 hops. Pure.
- `mergeReportedTerms(existing, reported)` (T139) — conservative auto-merge of model-reported terms
  (`parseReportedTerms` output): new terms are auto-added (reported `type`/`ru`, unique slug id, `count: 0`),
  never renames an existing entry — a differing `ru` is queued in `term.pending` (skipped for locked terms,
  T140: a locked term is never re-proposed); values in `rejected` are never applied or re-queued; `ignored`
  terms are never added. Pure (no input mutation).
- `termTagger` / `tagTerms(text, glossary)` — wraps occurrences as `<term id="ID">text</term>` (longest match
  first, no nesting, fenced/inline code and `#` headings skipped, idempotent, line count preserved). Result in
  `taggedItems` variable (item untouched). `stripTerms(tagged)` restores the original text exactly.
- `term-timeline.ts` (T141) — per-chapter term state for re-translation: `GlossaryTerm.ruTimeline` /
  `genderTimeline` hold `{chapter, value}` overrides effective from `chapter` onward (gender flips MUST carry
  verbatim `GenderEvidence`). `resolveTermAtChapter` / `resolveGlossaryAtChapter` / `genderFlipsAt` apply the
  timelines (terms with `firstChapter` after the chapter are "not yet introduced"), `validateTimeline` reports
  unsorted timelines / missing-or-empty evidence, `verifyEvidenceQuotes` checks each quote occurs verbatim in
  its chapter source. `buildTranslationPrompt({ chapter })` resolves the glossary at that chapter and announces
  active gender flips with their evidence quote; `translateTaggedChapter` passes the chapter through.
- `glossary-llm.ts` — the LLM stages of the extractor: `extractGlossaryWithLlm` (the `glossary.system` /
  `glossary.user` prompts), `relateTermWithLlm` (the `glossary-relations.*` prompts), `enrichTermWithLlm` (the
  `glossary-enrich.*` prompts); `mapCategory` maps a model category to a glossary type, `parseGlossaryEntries` /
  `parseNameRelations` parse the answers. The prompt texts are bundled md files (`packages/tools/prompts/glossary*.md`,
  ported from the machinum-llm `.ST` templates), loaded through `loadBundledPrompt`.

### `stat-freq.ts`
Offline (no LLM) statistical frequency analyzer (T147). Accepts `env.item` (string) or a batched
`env.items` corpus; the envelope (and its cardinality) is returned untouched.

- `statFreq` / `defineStatFreq(options)` / `createStatFreq(options)` — options `{ stopwords?, minWordLen?,
  maxNgram?, topK?, outFile? }`: `stopwords` extends the built-in EN+RU list, `minWordLen` (default 1) drops
  shorter tokens, `maxNgram` (default 3) caps the n-gram size, `topK` (default 500) caps every ranked list,
  `outFile` additionally writes the report as JSON (atomic write, parent dir created).
- Result in `statFreq` variable = `StatFreqReport`: `{ totalWords, uniqueWords, words: [{ word, count, share }],
  sentences: [{ sentence, count }], ngrams: [{ ngram, count }], top: [{ term, count, kind: 'word'|'ngram' }] }`.
  `totalWords` / `uniqueWords` count every token (stopwords included); `words` lists non-stopword tokens only,
  `sentences` only sentences occurring at least twice, `ngrams` only candidates without a stopword inside.
  Ranking: count desc, then term asc (code point, locale independent) — deterministic for the same input.
- Pure helpers: `buildStatFreqReport(texts, options)`, `splitStatSentences(text)`, `tokenizeWords(text)`.

### `stat-dict.ts`
Ranked translation dictionary built from a frequency report (T148). Offline, no LLM. The envelope (and its
cardinality) is returned untouched.

- `statDict` / `defineStatDict(options)` / `createStatDict(options)` — options `{ minCount?, topK?,
  glossaryFile?, reportFile?, outFile? }`: `minCount` (default 3) is the frequency threshold, `topK` (default 100)
  caps the new candidates, `glossaryFile` is the existing glossary to merge into, `reportFile` reads the
  `StatFreqReport` JSON from disk (overrides `statFreq` variable), `outFile` writes the merged glossary as JSON
  (atomic write, parent dir created).
- Report source: `reportFile` → `statFreq` variable → the envelope text (counted inline).
- Candidates: every term of `top`, `words` and `ngrams` (once, highest count wins) with `count >= minCount`,
  ranked count desc then term asc. Type = `guessType` on the capitalised term (n-grams default to `term`).
- Merge is conservative: existing entries are copied verbatim (id, term, type, count, `ru`, aliases, pending) and
  keep their order; new candidates are appended with an empty translation (`ru: null`) and a guessed type. A
  candidate matching an existing term or alias (case-insensitive) is skipped, `ignored` terms are never re-added.
  A missing glossary file means an empty glossary; a broken one is an error (translations are never dropped).
- Result in `statDict` variable = `Glossary` and `statDictJson` variable = its serialized form.
- Pure helpers: `buildStatDict(report, existing, options)`, `selectStatDictCandidates(report, options)`,
  `isStatFreqReport(value)`.

### `translation-prompt.ts` / `line-parity-linter.ts`
Building blocks of the sample4 translate stage (EN->RU, line by line).

- `buildTranslationPrompt({ text, glossary, summary, extraRules, mode })` — `{ systemPrompt, userPrompt, usedTerms,
  untranslatedTerms, lockedTerms }`. `mode` is the `TranslateWorkMode` (`'plain' | 'xml' | 'properties'`,
  default `'plain'` = previous behaviour; deprecated alias of the global `PromptWorkMode`). The system prompt is
  composed by `composePromptBlocks('translate', mode, vars)` from the bundled `translate.system`, the global
  `llm.format.<mode>` and the `translate.output.<mode>` templates (registered prompt-registry defaults;
  `{{sourceLang}}`, `{{targetLang}}`, `{{text}}`, `{{glossaryBlock}}`, `{{summaryBlock}}`, `{{extraRules}}`,
  `{{mode}}` vars), with the previous hand-built composition kept only as a fallback when a template is missing.
  Injects ONLY glossary entries whose `<term id>` occurs in `text` (`term = ru`); terms with `ru: null` get a
  "transliterate consistently" block; **locked terms are always injected even when their id does not occur in the
  text** (returned separately in `lockedTerms`), so fixed translations are rendered exactly as the human decided.
  The chapter summary is added as context only. The system prompt ends with a rule asking for a trailing
  `<terms>[...]</terms>` JSON block reporting source terms NOT in the glossary. `userPrompt` is the text with
  `<term>` tags stripped, wrapped per mode: `plain` is the bare text (no wrapper — the reply must be the
  translation line-by-line); `xml` wraps each line as
  `<result><id>N</id><origin>…</origin></result>`, `properties` as `N=text`, both inside a `<context>` block. `cleanTranslation(reply)` drops
  `<think>` blocks, `<terms>` report blocks and `<term>` tags; `parseReportedTerms(reply)` (zod-validated, never
  throws) parses the report into `ReportedTerm[]` (invalid entries dropped, deduped case-insensitively);
  `termIdsIn(text)` lists tag ids. `parseTranslationReply(reply, mode)` (in `translation-reply.ts`) parses a reply
  per mode: `xml`/`properties` extract and sort by numeric
  id/key, requiring contiguous 1..N — missing/duplicate ids/keys throw a retryable `TranslationReplyParseError`
  (a thin wrapper over the shared `StructuredReplyParseError` from `core/prompt-blocks.ts`; same retry contract
  as `LineParityError`).
- `lintLineParity(en, ru, opts)` (pure) / `lineParityLinter` / `createLineParityLinter({ throwOnError, minCyrillicRatio,
  cyrillicSeverity })` — `{ en, ru }` item in/out, `parity` variable = `{ ok, enLines, ruLines, errors, warnings,
  cyrillicRatio, issues[] }`. Hard errors: `line-count`, `empty-line-position`, `bracket-line-position`,
  `term-tag-left`, `think-block`, `low-cyrillic`; warn: `untranslated-line`. On a hard error the tool throws
  `LineParityError` (`retryable: true`) so the engine retry kicks in; after the last attempt the run fails with the
  message. `LineParityError.feedback` / `parityFeedback(report)` = measured feedback for retry-prompt injection
  (line counts + delta, Cyrillic ratio, hard-error messages; T138). Standalone check without `mt`: `samples/sample4/lint-parity.ts <enDir> <ruDir>` (table, exit 1 on mismatch).
- `lintPromptTemplate(name, text, { allowedVars })` (pure) / `lintPromptSet(family, templates, { modes, allowedVars,
  output })` (pure) / `lintTranslatePromptSet(templates)` (pure, thin wrapper for the `translate` family) — prompt
  template linter (issue objects, never throws): `placeholder-syntax` (unbalanced `{{`/`}}`, invalid names, triple
  braces), `single-brace-var` (ST-style `{text}` leftovers; ignored inside code fences), `unknown-var` (against
  `allowedVars`), `empty-template`. `lintPromptSet` guards a family's full prompt set used by
  `composePromptBlocks` (`<family>.system` renders with the builder var set; every mode has the global
  `llm.format.<mode>` block and an output block — `<family>.output.<mode>`, the single `<family>.output`, or an
  explicit `output` name). Exercised by `tests/prompt-linter.test.ts` against the real bundled translate /
  summary / proofread / `llm.format.*` sets (not called at runtime).

### Sample-stage tools (moved from `samples/sample4`, T129)
Reusable glue so sample pipelines only compose package tools (no bespoke `defineTool`).

- `core/llm-picker.ts` — `pickLlmTool({ env, mockSource, configPath })` / `readLlmConfig` / `LLM_TOOLS`: single LLM
  config point (`MT_LLM_TOOL`, `MT_LLM_MODEL`, `MT_LLM_USE`, mt.json `settings.llm.*`; default offline `mock`).
  Returns `{ tool, model, gate, schemaCall, translate }`. Pass `configPath` = the project's `mt.json`
  (default `./mt.json` of the cwd); its `imports` (e.g. a gitignored `mt.local.json`) are merged in first.
  Shared by sample3, sample4 and sample5. `mockLlmChoice(source, model)` is the offline mock backend as
  an `LlmChoice` (building block of `mockLlm`).
- `core/llm-install.ts` — process-level mock install (`defineProcess().install(mockLlm({ source }))`):
  a module registry holding the installed `LlmChoice` provider. LLM-backed factories
  (`createSummaryTool` family via `runPromptWithRetry`, `createTitleTranslator` /
  `createParagraphTranslator` via the default `translate` slot) call `resolveProcessLlm()` **at invoke
  time** when no explicit `call`/`translate` was passed: explicit arg > `MT_LLM_TOOL` / mt.json naming a
  real backend (lazy `pickLlmTool()`) > installed mock (pick = `mock`, the default) > factory default.
  Helpers: `installLlmProvider` / `uninstallLlmProvider` / `getInstalledLlmProvider` / `resetProcessLlm`
  (tests). Full write-up incl. the planned router-backed stub mode: [../guiding/mock-tools.md](../guiding/mock-tools.md).
- `normalization/chapter-record.ts` — `toChapterRecord`, `chapterRecordMapper` (raw `{key,value}` -> `"title\nbody"`,
  `meta.chapterNum`), `lineTextToMarkdown` (first line -> `# title`, other lines -> paragraphs, `{ text }`),
  `unwrapMarkdownText` (`{ text }` -> string, undoes remark `\[` escaping).
- `normalization/llm-typo-fix.ts` — `createLlmTypoFix({ call, enabled })`: rejects replies that change the line count.
- `normalization/llm-summary.ts` — `createLlmSummaryWithFallback({ call, enabled })`: LLM summary, heuristic summary
  (`heuristicSummaryByItem` variable) when the loop guard fell back. `enabled: false` = pass-through.
- `normalization/glossary-extractor.ts` — `readGlossaryFile(path)` (for `createGlossaryExtractor({ load })`).
- `modification/analyze-outputs.ts` — `analyzeOutputs` / `createAnalyzeOutputs({ summaryDir, taggedDir, glossaryFile })`:
  `mdOutputs` variable for `schema/chapter<N>.summary.md`, `en-tagged/chapter<N>.md`, `glossary.json`.
- `normalization/translation-stage.ts` — `onlyChapters()` (`MT_ONLY_CHAPTERS`), `translateConcurrency()`
  (`MT_TRANSLATE_CONCURRENCY`), `chaptersToTitleInputs`, `createGlossaryTitleTranslator({ call, chaptersDir, mode })` (slot for
  `createTitleTranslator`), `createChapterBodyTranslator({ call, chaptersDir, mode })` (per-line translate with glossary +
  summary injection and retry memo; `mode` selects the `TranslateWorkMode`, default `'plain'` = unchanged behaviour),
  `translateTaggedChapter`, `titleOf`. Non-plain replies are parsed with `parseTranslationReply` (retryable parse
  error on missing/duplicate ids/keys); the line-parity check compares against the source line. `chaptersDir` holds
  `glossary.json` and `schema/chapter<N>.summary.md`.
- `verification/chapter-pairs-linter.ts` — `chapterPairsLinter`: `lineParityLinter` over each `{ en, ru }` pair,
  `parityByChapter` variable.
- `modification/translate-outputs.ts` — `createTranslateOutputs({ chaptersDir })`: `ru/chapter<N>.md` + merged `titles.json`.

### `chapter-translator.ts`
Higher-level translation tools, composable:
- `titleTranslator` / `createTitleTranslator({ translate })` — slots `extract -> translate -> assemble`
  (title from frontmatter, H1, or first line).
- `paragraphTranslator` / `createParagraphTranslator({ translate, concurrency })` — slots `split -> translate -> assemble`.
  The translate slot runs paragraphs through the core's bounded `mapConcurrent` (`concurrency` option,
  default 4, output order preserved) and memoises each paragraph result for the lifetime of the tool
  instance, keyed by `(text, targetLang, sourceLang, translator name)` (LRU-bounded). A runner retry
  therefore only re-translates paragraphs that failed. Memo is skipped when the translator tool is
  marked `idempotent: false`.

The `translate` slot defaults to the process-level pick (`resolveProcessLlm`, installed mock /
`MT_LLM_TOOL` backend) falling back to `translateText`; all invocations go through one shared helper
(`translateVia`, no hand-built envelopes). Swap the translator for the whole tool either via the factory
option (any `Tool<TranslateInput, TranslateOutput>`) or per-slot via `.with({ translate })`.

### `openrouter-tool.ts`
LLM gates built on the LLM toolkit (see [LLM toolkit](#llm-toolkit)); I/O unchanged:
- `chatCompletion` — chat completion (composable: `prepare, fit, call, parse, emit`)
- `runPrompt` — simplified prompt runner
- `chatCompletionSingle`, `resolveRouterUrl` — direct one-shot helper / router URL resolution

Default provider is the MT router proxy (`/api/chat/completions`). The key pool from `openrouter-pool.ts`
(round-robin, 429/402) is used by the `openrouter` provider.

### `openrouter-free.ts`
- `openrouterFree` — free-tier gate: thin preset over `createLlmGate`. `OPENROUTER_FREE_LLM` is the
  tool-level **provider pin** only (`{ provider: 'openrouter' }` — direct OpenRouter, no MT router proxy);
  `OPENROUTER_FREE_DEFAULTS` is `llmDefaults` (`model: openrouter/free`). Keys come from the usual
  `resolveLlmConfig` env resolution (`OPENROUTER_API_KEYS` pool, then `OPENROUTER_API_KEY`),
  `baseUrl` defaults to `https://openrouter.ai/api/v1`.
  Standard slots, so tests stay offline: `openrouterFree.with({ call: mockLlmCall(['ok']) })`.
  **The model is a default, not a pin** (see [LLM config precedence](#llm-config-precedence-resolvellmconfig-pure)):
  per-call `model` / `llm.model` > tool layer > `llm` variable `.model` > mt.json `llm.model` > vault ref
  (`llm.use`) > provider env (`MT_OLLAMA_MODEL`) > `openrouter/free`. Generic `MT_LLM_MODEL` env stays
  *below* the preset default; the **provider** stays pinned (a vault entry of another provider errors).

### `openrouter-pool-tool.ts`
- `openrouterPool` / `createOpenrouterPool({ models?, strategy?, client? })` — like `openrouterFree` but with
  **sticky free-model pinning**: first call pins ONE model from `models` (default `['openrouter/free']`,
  `strategy` `first` | `random`), kept in a module-level Map keyed by baseUrl + key-set (shared across gate
  instances; `resetOpenrouterPoolPins()` for tests). Re-pins to the next candidate only on 404 (model
  unavailable), 429 with all keys blocked (`sharedPoolFor` pool state) or 402 quota; throws when every
  candidate failed. Key rotation is the existing `OpenRouterPoolSupplier`.
  The candidates are a **default, not a pin**: `models[0]` is passed as `llmDefaults`, only the provider sits
  on the tool layer, and `prepare` applies the sticky pin **only when `cfg.sources.model` is `preset-defaults`
  (or `default`)** — a per-call `model` / `llm.model`, `llm` variable `.model`, mt.json `llm.model`, provider env or
  vault ref wins and leaves the pin map untouched (no pin created, so `openrouterPool` variable stays absent).
  Pin recorded in the `openrouterPool` variable = `{ model, pinnedAt, repins }`.
  Offline: `.with({ call: mockLlmCall([...]) })` (pin applied in `prepare`) or `client: () => mockLlmClient(...)`
  (re-pin logic lives in the client wrapper, so a replaced `call` slot bypasses re-pin).

### `ollama-tool.ts`
- GPU IT `tests/it/router-vault.it.test.ts` loads the router standalone runtime by relative dynamic import (test-only; no `@mt/router` dependency in `package.json`, no layer change) to prove tools -> router -> vault `ollama` entry -> ollama without any API key.
- `ollamaTool` — gate against an ollama server: stock local by default, a remote GPU server by
  setting `MT_OLLAMA_URL` (e.g. `http://<gpu-host>:<port>/v1`; nothing host-specific is hardcoded). Thin preset over `createLlmGate`: tool layer `OLLAMA_LLM`
  (`{ provider: 'ollama', transport: 'fetch' }` — the server needs no API key, the OpenAI SDK
  refuses to construct without one), preset defaults `OLLAMA_DEFAULTS`
  (`baseUrl: http://localhost:11434/v1`, `model: gemma4:latest`).
  Endpoint from `MT_OLLAMA_URL`, model from `MT_OLLAMA_MODEL` (both beat the preset defaults,
  see [LLM config precedence](#llm-config-precedence-resolvellmconfig-pure)). A per-call
  `model` / `llm` override still wins.
- `listOllamaModels(baseUrl?)` — models of the server (`GET /api/tags`), returns
  `{ name, sizeBytes?, digest?, modifiedAt? }[]`.
- `listRouterModels(baseUrl?, { token?, fetch?, timeoutMs? })` — `GET <router>/api/models`, returns
  `{ id, ownedBy? }[]` (routable ids: `openrouter/free`, `ollama/<m>`, ...). Throws when unreachable.
  Provider `router` is keyless: the only credential is the optional `MT_ROUTER_TOKEN` (sent as bearer). Alias
  `ROUTER_FREE_MODEL` = `openrouter/free` (free OpenRouter model through the router). Router side:
  [router.md](router.md).
- `ollamaHealth(baseUrl?)` — `GET /api/version`; never throws, returns `{ ok, baseUrl, version?, error? }`
  (`ok: false` when the server is unreachable, e.g. `ECONNREFUSED`).
- `ollamaApiRoot(baseUrl?)` — native API root of an Ollama base URL (drops the `/v1` suffix).

### `md-formatter.ts`
- `mdFormatterTool` — reformats markdown with configurable line width. Uses remark/unified under the hood.

### `fs-read.ts` / `fs-write.ts`
The only modules allowed to touch `node:fs`: `fs-read.ts` owns all reads (`readTextFile`,
`readTextFileSync`, `readDirectory`, `isDirectory`); `fs-write.ts` delegates atomic writes to
`@mt/core` (`atomicWriteFile`, temp-then-rename). Everything else in `src/` goes through these two.

### `docker-compose.ts`
- `dockerComposeEmitter(options)` — dev-environment generator tool: renders a `docker-compose.yml`
  (hand-rolled YAML, no yaml dep) with minimal service presets (`services: Array<'ollama' | 'qdrant' |
  'lightrag'>` — image/port/volume; the `lightrag` image is a documented placeholder) and optional
  top-level docker compose `include:` entries (`include?: string[]`). `outPath?` defaults to
  `./docker-compose.yml`, resolved against `ctx.run.global.project.root`; written atomically via
  `fs-write.ts`. Returns `{ path, services, include }` as the item and records `dockerCompose` variable.
  The parent directory must already exist (same contract as `atomicWriteFile`).

### `token-splitter.ts`
Splits text at paragraph boundaries respecting a token limit. Uses heuristic token counting (`heuristicTokenCount`).

### `normalization/chunk-separator.ts`
Fixates source text into stable, token-bounded chunks joined by a `---` separator line; later runs reuse the
separator instead of re-splitting.

- `chunkClean` / `createChunkClean({ separator })` — strips separator + decorative-only lines, collapses blank
  runs; sets `chunkCount` (meta + variable) and `chunkSeparator` variable.
- `chunkSplit` / `createChunkSplit({ separator, chunkSize, reuse, count })` — clean + `splitIntoChunks` +
  `joinChunks`; with `reuse` (default true) text that already contains separator lines is kept as-is. Sets
  `chunkCount` (meta + variable) and `chunkSeparator` variable. Chunk size: `resolveChunkSize` →
  `meta.chunkSize` → tool option `chunkSize` → mt.json `settings.chunkSize` → `MT_CHUNK_SIZE` →
  `DEFAULT_CHUNK_TARGET` (6000).
- Pure helpers: `stripSeparators`, `splitIntoChunks` (paragraph → line → word boundaries, never mid-word,
  never loses/reorders text), `joinChunks`, `parseChunks` (inverse; no re-split).

### `normalization/chunk-tokens.ts`
Alternate descent `chunks -> tokens` (sibling of `chunks -> paragraphs`): tiktoken-style BPE tokens of a chunk.

- `chunkTokenize` / `createChunkTokenize({ encoding })` — `string` chunk in, `{ tokenId, text }[]` out; sets
  `tokenCount` (meta + variable) and the `tokenHeuristic` variable.
- `tokenizeChunk(text, { encoding? })` → `{ tokenId, text }[]`; `tokenizeChunkDetailed` also returns
  `heuristic: boolean`. Uses `gpt-tokenizer` (`encode` + `decode([id])` per token); falls back to ~4-char pieces
  (`heuristic: true`) when the package is unavailable.

### `word-counter.ts`
- `wordCounter` — counts words in an exchange, sets the `wordCount` variable.

### `chapter-indexer.ts`
Assigns ordering indexes to chapters based on filename patterns.

### `token-counter.ts`
Token counting via tiktoken (`cl100k_base`):
- `tokenCounter` — counts tokens of a string envelope item, sets the `tokenCount` variable. Creates/frees the encoder on every call (clean, no shared state).
- `tokenCounterBatch` — for batched envelopes (after `.batch(n)`): one encoder create/free per batch invoke. Adds `tokenCounts` (per item) and `tokenCount` (batch total) variables.
- `tokenCounterBatchCached` — same batch semantics, but reuses one process-wide cached encoder, freed via a `process.on('exit')` hook (one create/free per process). Use for large runs where encoder construction dominates.

## LLM toolkit

Files: `llm-client.ts` (types, adapters, `createLlmClient`), `llm-decorators.ts`, `llm-errors.ts`,
`llm-config.ts`, `llm-prompts.ts`, `llm-context.ts`, `llm-gate.ts`, `llm-translate.ts`,
`llm-sdk-transports.ts`. Plan: [plans/llm-toolkit.md](../plans/llm-toolkit.md).

**Layers:** adapter (`OpenAiCompatClient`: OpenAI/OpenRouter/Ollama/router/custom, `AnthropicClient`; fetch-based behind an
injectable `LlmTransport`, no SDK dep) or the official SDK adapters (`createOpenAiSdkClient`, `createAnthropicSdkClient`
in `llm-sdk-transports.ts`; `openai` / `@anthropic-ai/sdk` loaded lazily via dynamic `import()`, minimal structural local
interfaces, same typed error mapping incl. pool 429-block/402-disable) -> `withTimeout` (per-call timeout + `AbortSignal`) -> `withLlmRetry`
(core `withRetry`; only 429/5xx/network/timeout; policy = `ctx.run.global.defaults.retry`) -> `withCache` (core `Cache`,
stable key, opt-in). Typed errors: `LlmRateLimitError` (with `retryAfterMs`), `LlmAuthError`, `LlmQuotaError` (402), `LlmContextLengthError`,
`LlmServerError`, `LlmNetworkError`, `LlmTimeoutError`, `LlmAbortError`, `LlmParseError`. Secrets are never logged
(`redactLlmConfig`), and `apiKey` is never read from `meta` (checkpointed).

**Layered retries.** The decorator above and the engine's `withRetry` around `tool.invoke` obey the *same*
error contract (`retryable` / `retryAfterMs`, see [core.md](core.md#retry--error-policy)), so the two layers
do not multiply on a fatal error: a 402 / 401 / oversize prompt / parse error surfaces from the first attempt
at both levels instead of burning `max` backoffs each. A 429 waits the server's `retryAfterMs`, clamped to
`RetryPolicy.maxBackoffMs` (default 60s).

`LlmClient.chatCompletionStream?(req, onDelta?)` optionally aggregates content deltas (final usage included);
the non-streaming `chatCompletion` path is unchanged.

### LLM config precedence (`resolveLlmConfig`, pure)

First defined wins, per field: **call input** (`item.llm`, `item.model`) > **tool option** (`createLlmGate({ llm })`) >
**`llm` variable** > **mt.json `settings`** (`llm.provider`, `llm.model`, `llm.baseUrl`, `llm.apiKey`, `llm.timeoutMs`, `llm.retry`, `llm.cache`) >
**vault ref** (`llm.use` / `MT_LLM_USE` / `use` on any layer; expands `ctx.run.global.vault`, directly below the layer carrying the ref) >
**provider env** (`MT_OLLAMA_MODEL`, `MT_OLLAMA_URL`) > **preset defaults** (`createLlmGate({ llmDefaults })`) >
**env** > **default**.

Vault refs (`vault://<entry>[/<model>]` | `@vault/<entry>[/<model>]`, see [vault.md](../guiding/vault.md)): tools only read
`ctx.run.global.vault`, never files. Presets (`ollamaTool`, `openrouterFree`, `openrouterPool`) pin only the provider on
the tool layer (their model/endpoint are `llmDefaults`), so a vault model/endpoint wins; an entry of a different provider
throws naming the ref. Secrets are reported as `vault:<entry>` in `sources` and never reach meta/logs/errors.

| Field | Env | Default |
|---|---|---|
| provider | `MT_LLM_PROVIDER` | `router` (never inferred from keys) |
| model | `MT_OLLAMA_MODEL` (provider `ollama`), else `MT_LLM_MODEL` | `openai/gpt-4o-mini` (router/openrouter), `gpt-4o-mini`, `llama3.1`, `claude-haiku-4-5` |
| baseUrl | `MT_OLLAMA_URL` (provider `ollama`), else `MT_LLM_BASE_URL`; router: `ctx.routerUrl`, `MT_ROUTER_URL` | provider URL; router `http://localhost:7777` |
| apiKey(s) | `MT_LLM_API_KEY`, `OPENROUTER_API_KEYS` (pool), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | none |
| timeoutMs | `MT_LLM_TIMEOUT_MS` | 120000 |
| retry | (layers) then `ctx.defaults.retry` | `{max:3, backoffMs:1000, strategy:'exp'}` |
| cache | `MT_LLM_CACHE` | off |
| transport | `MT_LLM_TRANSPORT`, settings `llm.transport` | `sdk` when the provider SDK is resolvable, else `fetch`; `router` always `fetch` |

### Prompt precedence (`resolvePrompt(name, vars, sources, env)`)

**tool option** (`createLlmGate({ prompts: { name: text } })`) > **`prompts[name]` variable** > **settings `prompts.<name>`** >
**env `MT_PROMPT_<NAME>`** (`.`/`-` -> `_`, upper-case) > **registered default**. A value starting with `@` is a file path
(relative to the project root). Templates use `{{var}}`; a missing var throws `PromptVariableError`.
Defaults: `translate.system`, `translate.user`, `summary`, `entities`, `context.summarize`, `json.correction`,
`validation.correction` (`registerPrompt()` adds more).

### Context window (`contextWindow` tool, `fit` slot)

Budget = `min(maxTokens, contextLimit - reserve)`; no budget = no-op. Precedence: **item `context`** > **factory options** >
**`context` variable** > **settings `context.*`** > **env** (`MT_CONTEXT_MAX_TOKENS`, `MT_CONTEXT_LIMIT`, `MT_CONTEXT_RESERVE`,
`MT_CONTEXT_STRATEGIES`). Strategies run in order until the messages fit; system messages and the last user message are
protected by default. Built-ins: `truncateLines`, `truncateTail`, `truncateHead`, `summarize` (LLM, prompt `context.summarize`,
falls back to `dropOldest`), `dropOldest`, `dropMiddle`, `slidingWindow`; custom: pass a `ShrinkStrategy`
(`{ name, apply(messages, budget, helpers) }`) or `registerShrinkStrategy(name, factory)`. Token counting is injectable
(`countTokens`, default `countTextTokens` from `token-counter.ts`). Records `contextWindow` variable
`{before, after, budget, fits, applied[{name,before,after,note?}]}`.

**Oversize last user message** (`lastMessage`, default `off`): strategies protect the final user message from
shrinking, so a single oversize message can exceed the budget. `lastMessage: 'truncate'` keeps head+tail with an
elision marker, `'summarize'` rewrites it via the `context.summarize` prompt (needs an LLM), `'error'` throws a
clear `LlmContextLengthError`; the result is still reported in `contextWindow.applied` variable (`truncateLastMessage` /
`summarizeLastMessage`). The system message is never dropped. Config: settings `context.lastMessage` /
`MT_CONTEXT_LAST_MESSAGE`.

**Model context limits (`autoLimit`, default on):** when the model id is known, the budget is derived from the
maintained `MODEL_CONTEXT_LIMITS` table (major OpenAI/Anthropic/Google/Meta/Mistral/DeepSeek/Qwen families;
prefix/glob match incl. `provider/model` OpenRouter ids) minus `reserve` — no explicit `maxTokens` needed.
Extend/override via mt.json `context.limits` or `MT_CONTEXT_LIMITS` (`{"glob": tokens}` JSON), disable with
`context.autoLimit: false` / `MT_CONTEXT_AUTO_LIMIT=0`.

### Gates and swapping a slot

`createLlmGate(opts)` = `defineComposableTool` with slots `prepare -> fit -> call -> parse -> emit` (state travels as
`GateState` in `env.item`). Reliability: JSON mode (`responseFormat: 'json'`) parses with bounded corrective retries
(`jsonRetries`, default 2), `shrinkOnContextError` re-fits via the `fit` slot and retries on `LlmContextLengthError`,
usage/cost land in `llmUsage` variable. `check(content, input)` validates raw content (throw = reject): bounded
`checkRetries` (default 2) re-ask the model with the rejection reason appended (`validation.correction` template,
overridable; the reason also lands on `GateState.feedback`) — measured feedback e.g. `parityFeedback` steers the
retry (ranobe-tl self-correction, T138). `stream: true` (+ optional `onDelta(delta, input)`) makes the `call` slot use
`chatCompletionStream` when the transport supports it; the aggregated output and envelope shape are identical to
non-streaming.

```typescript
import { chatCompletion, createLlmGate, mockLlmCall } from '@mt/tools'

// swap `call` for a mock (tests/samples), original stays intact
.use(chatCompletion.with({ call: mockLlmCall(['answer 1', (req) => `echo ${req.model}`]) }))

// custom gate: own prompt, context budget, provider; swap only `fit`
const gate = createLlmGate({
  name: 'my-gate',
  llm: { provider: 'openai', model: 'gpt-4o-mini' },
  prompts: { summary: '@prompts/summary.md' },
  context: { maxTokens: 6000, strategies: ['truncateLines', 'summarize', 'dropOldest'] },
  shrinkOnContextError: true,
})
.use(gate.with({ fit: myFitTool }))   // any Tool or fn(env, ctx)
```

Tests: `tests/llm-*.test.ts`. Samples: `samples/sample3` `schemaDocMockPipeline` (`.with({ emit })` slot
override, offline mock) and `translateTitlesPipeline` / `translateChapterPipeline` (title / paragraph
translators resolving the process-level LLM pick — `defineProcess().install(mockLlm(...))`, no explicit
`translate` wiring).

## Key Patterns

**Tool signature:**
```typescript
export const myTool = defineTool<Input, Output>({
  name: 'my-tool',
  version: '1.0.0',
  mdDescription: 'Tool purpose in Markdown.',
  async invoke(env, ctx) {
    // transform env.item
    return { ...env, item: result }
  },
})
```

**Composable tools / overridable parts** (`md-outputs.ts`, core `defineComposableTool`):
```typescript
export const myDoc = defineComposableTool({
  name: 'my-doc', version: '1.0.0', mdDescription: '...',
  slots: {
    build: myBuildTool,                                        // pure: variables -> markdown
    emit: mdOutputEmitter({ name: 'my-doc', subdir: 'x', filename: (m) => `c${m.chapterNum}.md` }),
  },
})
// pipeline author: reuse build, replace emit (any Tool or fn); original stays intact
.use(myDoc.with({ emit: mockEmit }))
```
`appendMdOutput(ex, entry)` is the shared non-mutating `mdOutputs` variable append; `mdOutputEmitter` supports `when()` to skip.
New tools that write md should expose `build`/`emit` slots instead of hardcoding both. Tests: `tests/composition.test.ts`.

**OpenRouter pool** (`openrouter-pool.ts`):
- Round-robin across `OPENROUTER_API_KEYS` (comma-separated env var)
- 429 → marks key exhausted until TTL
- 402 → removes key permanently
- Pool recreates on TTL expiry

## Tests

Tests live in `packages/tools/tests/`:
- `docker-compose.test.ts` — compose generator: service presets, `include:` block, atomic write
- `chapter-doc.test.ts` — unit tests for doc read/write
- `schema-doc.test.ts` — schema-doc format tests (`readDoc` / `writeDoc` round-trip)
- `schema/prompt-retry.test.ts` — `runPromptWithRetry` loop guard, retries and attempt budget
- `schema/tools.test.ts` — the five extraction tools against a stubbed router, fallbacks included
- `schema/summary-notes.test.ts` — `createNotesSummaryTool` against a stubbed router (mocked LLM): bundled prompts, strict bullet validator, retries, heuristic fallback
- `bundled-prompts.test.ts` — generated prompt module in sync with `prompts/*.md`, loads with the `prompts/` dir absent
- `schema/mock-router.ts` — shared `fetch` stub and chapter fixtures (helper, not a test file)
- `md-formatter.test.ts` — formatter output tests
- `translate-text.test.ts` — translation tests (requires `OPENROUTER_API_KEYS`)
- `translate-slots.test.ts` — composable translateText / titleTranslator / paragraphTranslator (slot swaps, mock translator)
- `llm-config|prompts|context|client|gate.test.ts` — LLM toolkit (mock transport, no network)
- `llm-install.test.ts` — process-level mock install: `mockLlm` provider, `resolveProcessLlm` precedence
  (explicit arg > `MT_LLM_TOOL` real backend > installed mock > default), invoke-time factory fallback
- `llm-sdk-transports.test.ts` — official-SDK adapters (vi.mock'd `openai` / `@anthropic-ai/sdk`): error mapping, retry-after, pool block/disable, lazy load, cache skip
- `llm-context-limits.test.ts` — model context-limit table matching + `MT_CONTEXT_LIMITS` overrides
- `llm-stream.test.ts` — gate `stream: true` delta aggregation

The schema-doc tests stub `globalThis.fetch`, so they need neither a running router nor
`OPENROUTER_API_KEYS`; `translate-text.test.ts` is skipped unless that env var is set.

## Dependencies

`@mt/tools` depends on `@mt/core` for types and DSL builders. It does **not** depend on `@mt/waypoint` or `@mt/cli`.

## TL index (planned-tool spec)

The TL001–TL116 entries below are the planned-tool spec index — the full catalogue of specified tools
(vs. the implemented tools above). UC links point at [../guiding/uc.md](../guiding/uc.md).

| ID    | Tool                                 | Used in UCs                                    |
|-------|--------------------------------------|------------------------------------------------|
| TL001 | normalizeUnicode                     | [UC058](../guiding/uc.md)                                 |
| TL002 | trimWhitespace                       | [UC058](../guiding/uc.md)                                 |
| TL003 | detectEmptyParagraph                 | —                                              |
| TL004 | spellcheckLine                       | [UC057](../guiding/uc.md)                                 |
| TL005 | grammarCheckLine                     | [UC057](../guiding/uc.md)                                 |
| TL006 | detectRepeatedWords                  | [UC057](../guiding/uc.md)                                 |
| TL007 | titleCaseChapter                     | —                                              |
| TL008 | extractFrontmatter                   | [UC055](../guiding/uc.md)                                 |
| TL009 | validateISBN                         | —                                              |
| TL010 | detectDeadLinks                      | [UC055](../guiding/uc.md)                                 |
| TL011 | checkMarkdownLinks                   | [UC055](../guiding/uc.md)                                 |
| TL012 | countWords                           | —                                              |
| TL013 | readabilityScore                     | —                                              |
| TL014 | detectPassiveVoice                   | [UC057](../guiding/uc.md)                                 |
| TL015 | findWeaselWords                      | [UC057](../guiding/uc.md)                                 |
| TL016 | normalizeLineEndings                 | [UC058](../guiding/uc.md)                                 |
| TL017 | removeBOM                            | —                                              |
| TL018 | detectProfanity                      | —                                              |
| TL019 | extractEmails                        | —                                              |
| TL020 | detectUrls                           | —                                              |
| TL021 | splitLongParagraph                   | —                                              |
| TL022 | joinShortLines                       | —                                              |
| TL023 | addLineNumbers                       | —                                              |
| TL024 | detectNumericLists                   | —                                              |
| TL025 | capitalizeSentences                  | —                                              |
| TL026 | translateLine                        | [UC059](../guiding/uc.md), [UC060](../guiding/uc.md), [UC061](../guiding/uc.md) |
| TL027 | rewriteTone                          | —                                              |
| TL028 | callOpenRouterAgent                  | —                                              |
| TL029 | routeToRouter                        | —                                              |
| TL030 | extractKeyPhrases                    | —                                              |
| TL031 | embedForRAG                          | —                                              |
| TL032 | semanticSimilarity                   | —                                              |
| TL033 | detectPlagiarism                     | —                                              |
| TL034 | summarizeChapter                     | —                                              |
| TL035 | detectHallucination                  | —                                              |
| TL036 | expandContractions                   | [UC058](../guiding/uc.md)                                 |
| TL037 | detectGenderBias                     | —                                              |
| TL038 | checkConsistencyGlossary             | —                                              |
| TL039 | extractQuotes                        | —                                              |
| TL040 | detectEllipsisStyle                  | —                                              |
| TL041 | fixOrdinalNumbers                    | [UC058](../guiding/uc.md)                                 |
| TL042 | redactPII                            | —                                              |
| TL043 | detectAdverbs                        | [UC057](../guiding/uc.md)                                 |
| TL044 | checkSerialComma                     | —                                              |
| TL045 | extractAcronyms                      | —                                              |
| TL046 | convertNumberWords                   | [UC058](../guiding/uc.md)                                 |
| TL047 | detectDuplicateParagraphs            | —                                              |
| TL048 | splitByHeading                       | —                                              |
| TL049 | validateWordCountTarget              | —                                              |
| TL050 | generateAltText                      | —                                              |
| TL051 | translateWithContext                 | [UC059](../guiding/uc.md), [UC060](../guiding/uc.md), [UC061](../guiding/uc.md) |
| TL052 | expandAbbreviations                  | —                                              |
| TL053 | detectLongSentences                  | —                                              |
| TL054 | sentenceSplitter                     | [UC060](../guiding/uc.md)                                 |
| TL055 | detectWeaselTags                     | —                                              |
| TL056 | convertSmartPunctuation              | —                                              |
| TL057 | extractFootnotes                     | —                                              |
| TL058 | validateReferenceFormat              | —                                              |
| TL059 | detectClichés                        | [UC057](../guiding/uc.md)                                 |
| TL060 | convertRomanNumerals                 | —                                              |
| TL061 | detectMissingSpaces                  | —                                              |
| TL062 | fixStraightQuotes                    | [UC058](../guiding/uc.md)                                 |
| TL063 | detectHeadingLevelSkip               | [UC055](../guiding/uc.md)                                 |
| TL064 | addYAMLFrontmatter                   | —                                              |
| TL065 | checkReadingTime                     | —                                              |
| TL066 | detectRedundantPhrases               | —                                              |
| TL067 | extractCharacterNames                | —                                              |
| TL068 | convertDateFormats                   | —                                              |
| TL069 | detectAmbiguousPronouns              | —                                              |
| TL070 | keywordDensity                       | —                                              |
| TL071 | checkCodeBlockLanguage               | [UC055](../guiding/uc.md)                                 |
| TL072 | detectTrailingSpaces                 | —                                              |
| TL073 | detectUnescapedChars                 | —                                              |
| TL074 | checkInternalConsistencyNames        | —                                              |
| TL075 | extractTOC                           | —                                              |
| TL076 | detectOverusedWords                  | —                                              |
| TL077 | addLanguageTag                       | —                                              |
| TL078 | convertDialoguePunctuation           | —                                              |
| TL079 | splitRunonSentences                  | —                                              |
| TL080 | detectMissingSubject                 | —                                              |
| TL081 | extractStatistics                    | —                                              |
| TL082 | detectFillerWords                    | —                                              |
| TL083 | convertElision                       | —                                              |
| TL084 | checkHtmlEntities                    | —                                              |
| TL085 | detectRelativeTime                   | —                                              |
| TL086 | extractGlossaryTerms                 | —                                              |
| TL087 | capitalizeHeadings                   | —                                              |
| TL088 | detectLeadingWhitespace              | —                                              |
| TL089 | removeDuplicateSpaces                | —                                              |
| TL090 | extractUUIDs                         | —                                              |
| TL091 | detectSentenceSpacing                | —                                              |
| TL092 | convertFractionToUnicode             | —                                              |
| TL093 | detectMissingAltText                 | —                                              |
| TL094 | addSoftHyphens                       | —                                              |
| TL095 | detectURLShorteners                  | —                                              |
| TL096 | extractPullQuotes                    | —                                              |
| TL097 | checkEmojiUsage                      | —                                              |
| TL098 | normalizeWhitespaceAroundPunctuation | —                                              |
| TL099 | detectMicrosoftSmartTags             | —                                              |
| TL100 | extractResearchQuestions             | —                                              |
| TL101 | detectTautology                      | —                                              |
| TL102 | checkDialogueTagVariety              | —                                              |
| TL103 | convertNonBreakingSpaces             | —                                              |
| TL104 | detectLazyWord                       | —                                              |
| TL105 | extractTemporalExpressions           | —                                              |
| TL106 | chunkChapter                         | [UC056](../guiding/uc.md)                                 |
| TL107 | extractEntities                      | —                                              |
| TL108 | consolidateSummaries                 | —                                              |
| TL109 | generatePlotDiagram                  | —                                              |
| TL110 | detectScenes                         | —                                              |
| TL111 | generateImage                        | —                                              |
| TL112 | generateAudio                        | —                                              |
| TL113 | exportToVideo                        | —                                              |
| TL114 | indexWithLightRAG                    | —                                              |
| TL115 | synthesizeSpeech                     | —                                              |
| TL116 | runAutomataWorkflow                  | —                                              |

---

| Index | ID    | Name                                   | Input           | Output                                               | Category        | Complexity | Description                                                                                                          |
|:------|-------|----------------------------------------|-----------------|------------------------------------------------------|-----------------|------------|----------------------------------------------------------------------------------------------------------------------|
| 1     | TL001 | `normalizeUnicode`                     | `Line`          | `Line`                                               | Pre‑processing  | Low        | Replace smart quotes, ligatures, diacritics with NFKC form; no API calls.                                            |
| 2     | TL002 | `trimWhitespace`                       | `Line`          | `Line`                                               | Pre‑processing  | Low        | Remove leading/trailing spaces, collapse multiple spaces, trim empty lines.                                          |
| 3     | TL003 | `detectEmptyParagraph`                 | `Paragraph`     | `Paragraph & { isEmpty: boolean }`                   | Validation      | Low        | Flags paragraphs that contain only whitespace or zero characters.                                                    |
| 4     | TL004 | `spellcheckLine`                       | `Line`          | `Line & { typos: Typo[] }`                           | Typo Detection  | Low        | Uses Hunspell WASM dictionary; returns misspelled words + suggestions.                                               |
| 5     | TL005 | `grammarCheckLine`                     | `Line`          | `Line & { grammarIssues: Issue[] }`                  | Error Detection | Low        | Calls local LanguageTool server (HTTP) to get grammar/style errors.                                                  |
| 6     | TL006 | `detectRepeatedWords`                  | `Paragraph`     | `Paragraph & { repeated: Repeated[] }`               | Error Detection | Low        | Finds adjacent repeated words ("the the"), common typos via regex.                                                   |
| 7     | TL007 | `titleCaseChapter`                     | `Chapter`       | `Chapter`                                            | Formatting      | Low        | Converts chapter headings to proper title case (AP style rules).                                                     |
| 8     | TL008 | `extractFrontmatter`                   | `Chapter`       | `Chapter & { frontmatter: Record<string, unknown> }` | Metadata        | Low        | Parses YAML/TOML frontmatter block from chapter markdown.                                                            |
| 9     | TL009 | `validateISBN`                         | `Line`          | `Line & { isbnValid: boolean }`                      | Validation      | Low        | Scans line for ISBN‑10/‑13 patterns and validates check digits.                                                      |
| 10    | TL010 | `detectDeadLinks`                      | `Chapter`       | `Chapter & { deadLinks: Link[] }`                    | Error Detection | Low        | HEAD requests each URL in chapter; reports broken links.                                                             |
| 11    | TL011 | `checkMarkdownLinks`                   | `Paragraph`     | `Paragraph & { brokenInternalLinks: string[] }`      | Validation      | Low        | Validates internal anchor links (`#section`) against chapter headings.                                               |
| 12    | TL012 | `countWords`                           | `Line`          | `Line & { wordCount: number }`                       | Metrics         | Low        | Returns word count (split on whitespace) per line.                                                                   |
| 13    | TL013 | `readabilityScore`                     | `Chapter`       | `Chapter & { fleschKincaid: number }`                | Metrics         | Low        | Computes Flesch‑Kincaid grade level using syllable detection.                                                        |
| 14    | TL014 | `detectPassiveVoice`                   | `Line`          | `Line & { passiveCount: number }`                    | Style           | Low        | Simple regex for "is/was/were + past participle" patterns.                                                           |
| 15    | TL015 | `findWeaselWords`                      | `Line`          | `Line & { weaselWords: string[] }`                   | Style           | Low        | Lists occurrences of "might", "some", "perhaps", "maybe", etc.                                                       |
| 16    | TL016 | `normalizeLineEndings`                 | `Line`          | `Line`                                               | Pre‑processing  | Low        | Converts CR/LF/CRLF to LF consistently.                                                                              |
| 17    | TL017 | `removeBOM`                            | `Line`          | `Line`                                               | Pre‑processing  | Low        | Strips UTF‑8 BOM from first line if present.                                                                         |
| 18    | TL018 | `detectProfanity`                      | `Line`          | `Line & { profanityMatches: string[] }`              | Content Filter  | Low        | Checks line against wordlist; flags offensive terms.                                                                 |
| 19    | TL019 | `extractEmails`                        | `Paragraph`     | `Paragraph & { emails: string[] }`                   | Extraction      | Low        | Regex extraction of email addresses from text.                                                                       |
| 20    | TL020 | `detectUrls`                           | `Line`          | `Line & { urls: string[] }`                          | Extraction      | Low        | Finds HTTP/HTTPS URLs in line.                                                                                       |
| 21    | TL021 | `splitLongParagraph`                   | `Paragraph`     | `Paragraph[]`                                        | Pre‑processing  | Low        | Splits paragraph into multiple paragraphs at sentence boundaries when length > 500 chars.                            |
| 22    | TL022 | `joinShortLines`                       | `Chapter`       | `Chapter`                                            | Formatting      | Low        | Merges consecutive lines that are under 40 chars (likely line breaks in markdown).                                   |
| 23    | TL023 | `addLineNumbers`                       | `Line`          | `Line & { lineNumber: number }`                      | Metadata        | Low        | Annotates each line with its index inside the paragraph.                                                             |
| 24    | TL024 | `detectNumericLists`                   | `Paragraph`     | `Paragraph & { isNumberedList: boolean }`            | Structure       | Low        | Checks if paragraph starts with "1. ", "2. " etc.                                                                    |
| 25    | TL025 | `capitalizeSentences`                  | `Paragraph`     | `Paragraph`                                          | Formatting      | Low        | Ensures first letter of each sentence is capitalised (basic regex).                                                  |
| 26    | TL026 | `translateLine`                        | `Line`          | `Line`                                               | Translation     | Medium     | Uses `ToolContext.translator` (LibreTranslate or OpenRouter) to translate line to target language from `RunContext`. |
| 27    | TL027 | `rewriteTone`                          | `Paragraph`     | `Paragraph`                                          | Rewriting       | Medium     | Calls `ToolContext.llm` with system prompt to change tone: academic → conversational, formal → friendly.             |
| 28    | TL028 | `callOpenRouterAgent`                  | `Paragraph`     | `Paragraph & { agentResult: unknown }`               | Agent           | Medium     | Sends paragraph to an OpenRouter‑hosted agent (e.g., fact‑checker, summarizer). Stores output in metadata.           |
| 29    | TL029 | `routeToRouter`                        | `Line`          | `Line & { nextTool: string }`                        | Router          | Medium     | Rule‑based: if line contains "TODO" → route to `rewriteTodo`; if citation → `expandCitation`.                        |
| 30    | TL030 | `extractKeyPhrases`                    | `Chapter`       | `Chapter & { keywords: string[] }`                   | NLP             | Medium     | Pure TS TF‑IDF or YAKE implementation; returns top 10 phrases.                                                       |
| 31    | TL031 | `embedForRAG`                          | `Chapter`       | `Chapter & { embedding: number[] }`                  | Indexing        | Medium     | Uses `ToolContext.embedder` (Transformers.js) to create vector; stores in `RunContext.vectorStore`.                  |
| 32    | TL032 | `semanticSimilarity`                   | `Chapter`       | `Chapter & { similarityToPrevious: number }`         | Analysis        | Medium     | Compares embedding of current chapter with previous one; outputs cosine similarity.                                  |
| 33    | TL033 | `detectPlagiarism`                     | `Paragraph`     | `Paragraph & { duplicateSources: string[] }`         | Validation      | Medium     | Hashes paragraph and checks against `RunContext.fingerprintCache` (local dedup).                                     |
| 34    | TL034 | `summarizeChapter`                     | `Chapter`       | `Chapter & { summary: string }`                      | Summarization   | Medium     | Uses LLM (lightweight, e.g., Mistral via Ollama) to generate 2‑sentence summary.                                     |
| 35    | TL035 | `detectHallucination`                  | `Chapter`       | `Chapter & { hallucinationScore: number }`           | Validation      | Medium     | Checks claims against a knowledge base or uses self‑consistency with multiple LLM queries.                           |
| 36    | TL036 | `expandContractions`                   | `Line`          | `Line`                                               | Pre‑processing  | Low        | Expands "don't" → "do not", "it's" → "it is" (custom mapping).                                                       |
| 37    | TL037 | `detectGenderBias`                     | `Paragraph`     | `Paragraph & { biasTerms: string[] }`                | Style           | Low        | Finds "policeman", "fireman", "chairman" and suggests alternatives.                                                  |
| 38    | TL038 | `checkConsistencyGlossary`             | `Chapter`       | `Chapter & { glossaryViolations: string[] }`         | Validation      | Low        | Ensures preferred term from glossary is used (e.g., "e‑mail" not "email").                                           |
| 39    | TL039 | `extractQuotes`                        | `Paragraph`     | `Paragraph & { quotes: string[] }`                   | Extraction      | Low        | Finds text between single/double quotes or guillemets.                                                               |
| 40    | TL040 | `detectEllipsisStyle`                  | `Line`          | `Line & { ellipsisOk: boolean }`                     | Style           | Low        | Warns if "..." not used as a single character `…` or spaced incorrectly.                                             |
| 41    | TL041 | `fixOrdinalNumbers`                    | `Line`          | `Line`                                               | Formatting      | Low        | Replaces "1st", "2nd", "3rd" with "first", "second", "third" (configurable).                                         |
| 42    | TL042 | `redactPII`                            | `Paragraph`     | `Paragraph`                                          | Privacy         | Low        | Masks phone numbers, email addresses, SSN patterns with `[REDACTED]`.                                                |
| 43    | TL043 | `detectAdverbs`                        | `Line`          | `Line & { adverbCount: number }`                     | Style           | Low        | Lists "‑ly" adverbs (quickly, happily) for style suggestions.                                                        |
| 44    | TL044 | `checkSerialComma`                     | `Paragraph`     | `Paragraph & { missingSerialComma: boolean }`        | Style           | Low        | Detects missing Oxford comma in lists of three or more items.                                                        |
| 45    | TL045 | `extractAcronyms`                      | `Chapter`       | `Chapter & { acronyms: Record<string, string> }`     | Extraction      | Low        | Finds definitions like "(API)" and builds acronym table.                                                             |
| 46    | TL046 | `convertNumberWords`                   | `Line`          | `Line`                                               | Formatting      | Low        | Turns "twenty‑five" → "25" (or reverse) based on `RunContext.style`.                                                 |
| 47    | TL047 | `detectDuplicateParagraphs`            | `Chapter`       | `Chapter & { duplicates: number[][] }`               | Error Detection | Low        | Hashes paragraph content; reports indices of identical paragraphs.                                                   |
| 48    | TL048 | `splitByHeading`                       | `Chapter`       | `Chapter[]`                                          | Pre‑processing  | Low        | Splits a chapter into sub‑chapters at Markdown heading levels (`##`).                                                |
| 49    | TL049 | `validateWordCountTarget`              | `Chapter`       | `Chapter & { withinTarget: boolean }`                | Validation      | Low        | Compares word count against `RunContext.wordTarget` (min/max).                                                       |
| 50    | TL050 | `generateAltText`                      | `Paragraph`     | `Paragraph` (image descriptions)                     | Accessibility   | Medium     | Uses local vision model (Moondream) or LLM to describe images embedded in paragraph.                                 |
| 51    | TL051 | `translateWithContext`                 | `Paragraph`     | `Paragraph`                                          | Translation     | Medium     | Uses running context (previous 2 paragraphs) to improve translation accuracy via LLM.                                |
| 52    | TL052 | `expandAbbreviations`                  | `Paragraph`     | `Paragraph`                                          | Pre‑processing  | Low        | Replaces common abbrevs: "e.g." → "for example", "i.e." → "that is".                                                 |
| 53    | TL053 | `detectLongSentences`                  | `Line`          | `Line & { longSentences: number[] }`                 | Style           | Low        | Flags sentences > 30 words, suggests breaking.                                                                       |
| 54    | TL054 | `sentenceSplitter`                     | `Paragraph`     | `Line[]` (sentence‑based)                            | Pre‑processing  | Low        | Converts paragraph into array of `Line` objects, one per sentence.                                                   |
| 55    | TL055 | `detectWeaselTags`                     | `Line`          | `Line & { weaselTags: string[] }`                    | Style           | Low        | Finds "some experts say", "it is believed that", "many people think".                                                |
| 56    | TL056 | `convertSmartPunctuation`              | `Line`          | `Line`                                               | Pre‑processing  | Low        | Replaces curly quotes, apostrophes, em‑dashes with straight equivalents (or vice versa).                             |
| 57    | TL057 | `extractFootnotes`                     | `Chapter`       | `Chapter & { footnotes: Footnote[] }`                | Extraction      | Low        | Parses markdown `[^1]` style footnotes and their definitions.                                                        |
| 58    | TL058 | `validateReferenceFormat`              | `Paragraph`     | `Paragraph & { refErrors: string[] }`                | Validation      | Low        | Checks that citations (`[Author, year]`) match a bibliography.                                                       |
| 59    | TL059 | `detectClichés`                        | `Line`          | `Line & { clichés: string[] }`                       | Style           | Low        | Checks line against a list of 200 common clichés.                                                                    |
| 60    | TL060 | `convertRomanNumerals`                 | `Line`          | `Line`                                               | Formatting      | Low        | Converts Roman numerals (IV, XIX) to integers, configurable on/off.                                                  |
| 61    | TL061 | `detectMissingSpaces`                  | `Line`          | `Line & { missingSpaces: number[][] }`               | Error Detection | Low        | Finds "end.Start" or "word.Word" patterns missing space.                                                             |
| 62    | TL062 | `fixStraightQuotes`                    | `Line`          | `Line`                                               | Formatting      | Low        | Replaces straight quotes with curly quotes for proper typography.                                                    |
| 63    | TL063 | `detectHeadingLevelSkip`               | `Chapter`       | `Chapter & { levelSkips: number[] }`                 | Structure       | Low        | Warns if markdown heading jumps from H2 to H4 (skipping H3).                                                         |
| 64    | TL064 | `addYAMLFrontmatter`                   | `Chapter`       | `Chapter` (if missing)                               | Metadata        | Low        | Inserts default frontmatter block with creation date and status from `RunContext`.                                   |
| 65    | TL065 | `checkReadingTime`                     | `Chapter`       | `Chapter & { readingTimeMinutes: number }`           | Metrics         | Low        | Calculates based on 200‑250 wpm.                                                                                     |
| 66    | TL066 | `detectRedundantPhrases`               | `Paragraph`     | `Paragraph & { redundancies: string[] }`             | Style           | Low        | Finds "advance planning", "end result", "free gift".                                                                 |
| 67    | TL067 | `extractCharacterNames`                | `Chapter`       | `Chapter & { characters: string[] }`                 | NLP             | Low        | Uses proper noun detection (capitalized words not at start of sentence).                                             |
| 68    | TL068 | `convertDateFormats`                   | `Paragraph`     | `Paragraph`                                          | Formatting      | Low        | Normalizes "01/02/2024" to "2 January 2024" based on locale config.                                                  |
| 69    | TL069 | `detectAmbiguousPronouns`              | `Paragraph`     | `Paragraph & { ambiguousRefs: string[] }`            | Style           | Medium     | Uses simple co‑reference heuristics to find "it", "they" without clear antecedent.                                   |
| 70    | TL070 | `keywordDensity`                       | `Chapter`       | `Chapter & { density: Record<string, number> }`      | Metrics         | Low        | Reports frequency of top 20 keywords (excluding stopwords).                                                          |
| 71    | TL071 | `checkCodeBlockLanguage`               | `Chapter`       | `Chapter & { unmarkedCodeBlocks: number[] }`         | Validation      | Low        | Finds markdown code fences without language specifier.                                                               |
| 72    | TL072 | `detectTrailingSpaces`                 | `Line`          | `Line & { hasTrailingSpace: boolean }`               | Formatting      | Low        | Flags lines ending with spaces (annoying in markdown).                                                               |
| 73    | TL073 | `detectUnescapedChars`                 | `Line`          | `Line & { unescaped: string[] }`                     | Error Detection | Low        | Finds asterisks, underscores inside words without escaping (`*word*`).                                               |
| 74    | TL074 | `checkInternalConsistencyNames`        | `Chapter`       | `Chapter & { nameVariants: string[][] }`             | Error Detection | Medium     | Groups possible same entities: "Jon", "John", "Jonathan" – suggests unification.                                     |
| 75    | TL075 | `extractTOC`                           | `Chapter`       | `Chapter & { toc: TocEntry[] }`                      | Extraction      | Low        | Builds table of contents from markdown headings.                                                                     |
| 76    | TL076 | `detectOverusedWords`                  | `Chapter`       | `Chapter & { overused: Record<string, number> }`     | Style           | Low        | Flags words used more than `n` times per chapter (configurable, e.g., "very", "really").                             |
| 77    | TL077 | `addLanguageTag`                       | `Line`          | `Line & { detectedLang: string }`                    | Metadata        | Medium     | Uses `cld3` or `franc` in TS to detect language per line.                                                            |
| 78    | TL078 | `convertDialoguePunctuation`           | `Paragraph`     | `Paragraph`                                          | Formatting      | Low        | Replaces double quotes with single for British English (or configurable).                                            |
| 79    | TL079 | `splitRunonSentences`                  | `Paragraph`     | `Paragraph`                                          | Pre‑processing  | Low        | Splits sentences joined by ", and" or ", but" into separate sentences.                                               |
| 80    | TL080 | `detectMissingSubject`                 | `Line`          | `Line & { missingSubject: boolean }`                 | Grammar         | Medium     | Simple heuristic: sentence starting with verb (imperative detection with exceptions).                                |
| 81    | TL081 | `extractStatistics`                    | `Chapter`       | `Chapter & { stats: ChapterStats }`                  | Metrics         | Low        | Returns char count, sentence count, avg word length, etc.                                                            |
| 82    | TL082 | `detectFillerWords`                    | `Line`          | `Line & { fillers: string[] }`                       | Style           | Low        | Finds "um", "uh", "like", "actually", "basically".                                                                   |
| 83    | TL083 | `convertElision`                       | `Line`          | `Line`                                               | Formatting      | Low        | Expands "gonna" → "going to", "wanna" → "want to".                                                                   |
| 84    | TL084 | `checkHtmlEntities`                    | `Line`          | `Line & { unescapedEntities: string[] }`             | Validation      | Low        | Finds `&` not followed by `&amp;` in non‑code contexts.                                                              |
| 85    | TL085 | `detectRelativeTime`                   | `Paragraph`     | `Paragraph & { relativeTimes: string[] }`            | Error Detection | Low        | Flags "tomorrow", "yesterday", "next week" (may date the book).                                                      |
| 86    | TL086 | `extractGlossaryTerms`                 | `Chapter`       | `Chapter & { terms: string[] }`                      | Extraction      | Low        | Builds list of bold/italic terms that might need glossary entries.                                                   |
| 87    | TL087 | `capitalizeHeadings`                   | `Chapter`       | `Chapter`                                            | Formatting      | Low        | Converts heading text to proper case (configurable: title case or sentence case).                                    |
| 88    | TL088 | `detectLeadingWhitespace`              | `Line`          | `Line & { indentLevel: number }`                     | Structure       | Low        | Counts leading spaces or tabs for code block detection.                                                              |
| 89    | TL089 | `removeDuplicateSpaces`                | `Line`          | `Line`                                               | Pre‑processing  | Low        | Replaces multiple spaces with single space (except within code blocks).                                              |
| 90    | TL090 | `extractUUIDs`                         | `Line`          | `Line & { uuids: string[] }`                         | Extraction      | Low        | Finds UUID‑v4 patterns in text.                                                                                      |
| 91    | TL091 | `detectSentenceSpacing`                | `Line`          | `Line & { doubleSpaceAfterPeriod: boolean }`         | Style           | Low        | Flags double spaces after period (old‑style typography).                                                             |
| 92    | TL092 | `convertFractionToUnicode`             | `Line`          | `Line`                                               | Formatting      | Low        | Changes "1/2" → "½", "3/4" → "¾" (configurable).                                                                     |
| 93    | TL093 | `detectMissingAltText`                 | `Chapter`       | `Chapter & { imagesWithoutAlt: string[] }`           | Accessibility   | Low        | Finds markdown images `![]()` missing alt text inside brackets.                                                      |
| 94    | TL094 | `addSoftHyphens`                       | `Line`          | `Line`                                               | Typesetting     | Low        | Adds `&shy;` after certain syllables for better line breaking (naive).                                               |
| 95    | TL095 | `detectURLShorteners`                  | `Line`          | `Line & { shortenedURLs: string[] }`                 | Security        | Low        | Flags `bit.ly`, `tinyurl`, `goo.gl` links for expansion.                                                             |
| 96    | TL096 | `extractPullQuotes`                    | `Chapter`       | `Chapter & { pullQuotes: string[] }`                 | Extraction      | Low        | Finds sentences enclosed in `> ` blockquotes.                                                                        |
| 97    | TL097 | `checkEmojiUsage`                      | `Line`          | `Line & { emojis: string[] }`                        | Content         | Low        | Lists emoji characters; optionally warns if outside designated sections.                                             |
| 98    | TL098 | `normalizeWhitespaceAroundPunctuation` | `Line`          | `Line`                                               | Pre‑processing  | Low        | Removes space before comma/period, adds space after comma.                                                           |
| 99    | TL099 | `detectMicrosoftSmartTags`             | `Paragraph`     | `Paragraph & { smartTags: string[] }`                | Validation      | Low        | Finds leftover `<st1:...>` tags from Word export.                                                                    |
| 100   | TL100 | `extractResearchQuestions`             | `Chapter`       | `Chapter & { questions: string[] }`                  | Extraction      | Low        | Finds sentences ending with `?` (potential reader questions).                                                        |
| 101   | TL101 | `detectTautology`                      | `Line`          | `Line & { tautologies: string[] }`                   | Style           | Low        | Finds "added bonus", "future plans", "past history".                                                                 |
| 102   | TL102 | `checkDialogueTagVariety`              | `Chapter`       | `Chapter & { tagOveruse: Record<string, number> }`   | Style           | Low        | Counts "said", "asked", "replied", warns if one dominates.                                                           |
| 103   | TL103 | `convertNonBreakingSpaces`             | `Line`          | `Line`                                               | Pre‑processing  | Low        | Replaces `&nbsp;` with normal space, except in code blocks.                                                          |
| 104   | TL104 | `detectLazyWord`                       | `Line`          | `Line & { lazyWordCount: number }`                   | Style           | Low        | Flags "thing", "something", "stuff", "nice", "good" without specifics.                                               |
| 105   | TL105 | `extractTemporalExpressions`           | `Paragraph`     | `Paragraph & { timex: string[] }`                    | Analysis        | Medium     | Uses simple patterns ("in 2024", "during the 19th century") for timeline extraction.                                 |
| 106   | TL106 | `chunkChapter`                         | `Chapter`       | `Chapter[]`                                          | Pre‑processing  | Medium     | Splits chapter > 12000 tokens into smaller parts for LLM processing.                                                 |
| 107   | TL107 | `extractEntities`                      | `Chapter`       | `Chapter & { entities: Entity[] }`                   | NLP             | Medium     | Finds and marks named entities (persons, places, organizations) in text.                                             |
| 108   | TL108 | `consolidateSummaries`                 | `Summary[]`     | `Summary`                                            | Summarization   | Medium     | Merges multiple chapter summaries into a consolidated summary.                                                       |
| 109   | TL109 | `generatePlotDiagram`                  | `Chapter`       | `Chapter & { plotDiagram: PlotNode[] }`              | Visualization   | High       | Creates visual plot diagram showing narrative structure, conflicts, and character arcs.                              |
| 110   | TL110 | `detectScenes`                         | `Chapter`       | `Chapter & { scenes: Scene[] }`                      | Analysis        | Medium     | Parses chapter into scenes based on time/location changes or action beats.                                           |
| 111   | TL111 | `generateImage`                        | `Chapter`       | `Scene` (or `Summary`)                               | `Image`         | Media      | Uses AI image generation (e.g., Flux) to create visual for chapter/scene/summary.                                    |
| 112   | TL112 | `generateAudio`                        | `Chapter`       | `Scene` (or `Summary`)                               | `Audio`         | Media      | Uses TTS (machinum-tts) to add audio narration for content.                                                          |
| 113   | TL113 | `exportToVideo`                        | `Image & Audio` | `Video`                                              | Media           | High       | Combines generated image with audio track to produce MP4 video.                                                      |
| 114   | TL114 | `indexWithLightRAG`                    | `Chapter`       | `Chapter & { ragDocId: string }`                     | Indexing        | High       | Indexes chapter content in LightRAG vector store for retrieval.                                                      |
| 115   | TL115 | `synthesizeSpeech`                     | `Text`          | `Audio`                                              | Media           | Medium     | Uses machinum-tts for high-quality speech synthesis.                                                                 |
| 116   | TL116 | `runAutomataWorkflow`                  | `Chapter`       | `Chapter & { automataResult: unknown }`              | Agent           | High       | Executes automation workflow via machinum-automata.                                                                  |
