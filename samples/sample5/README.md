# Sample 5 - One pipeline per LLM tool, judge the quality by eye

Every LLM-backed tool of `@mt/tools` runs alone in its own tiny pipeline on the same small input
(`input/en`: two chapters of `books/book1`; `input/typos`: one chapter with planted typos;
`input/glossary.json`: four names with fixed RU forms). Each run writes
`out/<tool>/<name>.md` with **Input**, **Output** and **Run info** in one file, so you compare the
model answer with the source without opening anything else.

Offline by default (`mock` backend, nothing leaves the machine); point it at a remote ollama with one
local file (below).

## What you will learn

- How `pickLlmTool` wires one backend into every tool (`llm.schemaCall`, `llm.translate`) and how
  `lib/llm.ts` adds a per-tool model override.
- How `mt.json` `imports` pulls in a gitignored `mt.local.json` (remote endpoint + models).
- How to read the diagnostics the tools leave in `meta` (`fallbackUsed`, `attempts`, `llmFixed`,
  `proofread`) next to the text.

## Directory layout

```
samples/sample5/
├── mt.json                  # settings.llm.tool = mock, imports ./mt.local.json
├── mt.local.example.json    # template of the local file (copy to mt.local.json)
├── mt.local.json            # YOUR settings - gitignored, never committed
├── check-llm.ts             # prints backend/model, pings ollama, lists its models
├── lib/                     # llm.ts (pickFor), report.ts (side-by-side md), translate*.ts
├── pipelines/<tool>.ts      # one tool each, ~20 lines
├── input/                   # committed fixtures
├── out/<tool>/              # generated reports (gitignored; `pnpm run cleanup` removes them)
└── tests/pipelines.test.ts  # runs every pipeline offline (mock) and asserts the reports
```

## Remote ollama: settings import

1. Reach the server. Example with an SSH tunnel (generic, fill in your own host and ports):
   `ssh -N -L 11434:localhost:11434 <user>@<gpu-host>`. Then the URL is `http://localhost:11434/v1`.
2. `cp mt.local.example.json mt.local.json` and edit it:

   ```json
   { "settings": {
       "llm.tool": "ollama",
       "llm.baseUrl": "http://localhost:11434/v1",
       "llm.model": "gemma4:latest",
       "llm.model.translate": "gemma4:latest"
   } }
   ```

   - `llm.tool`: `ollama` (or `router`, `openrouter-free`, ...; default `mock`).
   - `llm.baseUrl` / `llm.model`: endpoint and default model for every pipeline.
   - `llm.model.<pipeline>`: model for one pipeline, e.g. `llm.model.summary`, `llm.model.glossary`
     (all translate modes and `proofread` share `llm.model.translate`).
3. `pnpm --filter=sample5 run check-llm` - expect `ok` (server answers, model exists).
4. Run a tool, e.g. `pnpm --filter=sample5 run summary`, open `out/summary/chapter1.md`.

`mt.json` lists `"imports": ["./mt.local.json"]`; the file is deep-merged over `mt.json` (local wins) and
may be absent (then the mock backend runs). It is gitignored, so the real host never reaches the repo.
Alternatives that keep working: env `MT_LLM_TOOL=ollama MT_LLM_MODEL=... MT_OLLAMA_URL=...`
(env beats the file), per-pipeline `MT_LLM_MODEL_<PIPELINE>` (`MT_LLM_MODEL_TYPO_FIX`), or a vault entry
(`MT_LLM_USE=@vault/<entry>`, see `docs/vault.md`). A `.env` file alone is NOT enough: it only reaches the
call-time context (URL), not the backend choice made when the pipeline loads.

## Pipelines: what to look at

Run all with `pnpm --filter=sample5 run <script>`. "fallback" = the tool rejected the model answer
after its retries and used a deterministic substitute; the report shows it in **Run info**.

| Script | Tool | Look at |
|---|---|---|
| `summary` | `createSummaryTool` | 3-6 sentences, facts match, nothing invented; `fallbackUsed` false |
| `summary-notes` | `createNotesSummaryTool` | one concrete fact per `- ` note, no repeats |
| `entities` | `createEntitiesTool` | real names only, spelled as in the text, none missing |
| `ner` | `namedEntityTool` (offline) | baseline for `entities`: what a heuristic finds / misses |
| `vocabulary` | `createVocabularyTool` | words occur in the text, important first, no duplicates |
| `metadata` | `createMetadataTool` | numbers copied from the measured values (`fallbackUsed` false) |
| `schema` | `createSchemaTool` | mermaid renders; nodes are real events, edges in story order |
| `typo-fix` | `createLlmTypoFix` | `stillInText` 0 of 9 planted typos, nothing else rewritten, `llmFixed` true |
| `translate` | glossary translator, mode `plain` | glossary names exact (Sir Aldric -> сэр Алдрик), one RU line per EN line |
| `translate:xml` | mode `xml` (`<result><id>`) | ids kept, lines not merged; compare with `plain` |
| `translate:properties` | mode `properties` (`N=text`) | keys kept; compare with `plain` |
| `translate:paragraphs` | `createParagraphTranslator` | baseline without glossary: paragraph count, name consistency |
| `translate:title` | `createTitleTranslator` | "Chapter N" kept as number, only the heading changed |
| `proofread` | translate + `createStatProofread` | `issues`, `cyrillicShare`, `untranslatedShare`; then read the RU text |
| `glossary` | `createGlossaryExtractor` (LLM stages on) | real names, right `type`, useful `description`, sensible `references` |
| `statdata` | `statFreq` + `createStatDict` (offline) | top terms are story terms, candidate types make sense |
| `stat-dict-translate` | `createStatTranslateDict` | every candidate has a sensible RU form, ids all returned |

`proofread` has no LLM step of its own: the repo only ships the statistical proofreader, so the pipeline
translates first and then measures the result.

## How to clean up

`pnpm --filter=sample5 run cleanup` removes `out/` and `.mt/`.

## How the test works

`tests/pipelines.test.ts` runs each pipeline with `mt run` and `MT_LLM_TOOL=mock` (so a local
`mt.local.json` can never send the test to a real server), then asserts that every expected report exists
with its **Input** and **Output** sections. The mock answers are fake (`слово ...`), so it checks the
plumbing, not the model quality. No network, no LLM: deterministic. Outputs are removed after a green run
and kept for debugging after a failure.
