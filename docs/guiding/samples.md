# Samples

| Sample  | Path              | What it demonstrates                                          |
|---------|-------------------|---------------------------------------------------------------|
| sample0 | `samples/sample0` | `mt init` integration test — validates scaffolded artifacts   |
| sample1 | `samples/sample1` | HTTP → JSONL pipeline (`hs://` source, `jsonl://` target)     |
| sample2 | `samples/sample2` | Markdown processing in two flavours — basics (`pipelines/basic-md-processing.ts`: source → shipped `wordCounter`/`toMarkdownTool`/`statFreq` → target, zero `defineTool`; three exported pipelines with no active default export, so `mt run` builds an implicit suite of all three (commented `defineSuite` examples show explicit order/mode or defaulting one pipeline)) and custom (`pipelines/custom-md-processing.ts`: one bespoke `defineTool`, entity buffers `lines://`/`words://`, sync/async/parallel steps, `.fork()` branches, non-blocking counter branch); entity pipeline (JSONL → md → Chapter → Paragraph → Line → Word) with `paragraphs://`/`lines://` buffers and fork vs parallel demos; chunk normalization (`chunkSplit` cleans → token-bounded chunks → `---` separators → separator reuse on a second run) and the Structure Ladder (jsonl → md → chunks ─┬→ paragraphs → lines → words / └→ tokens) with per-rung summaries (`pipelines/chunk-normalization.ts`: `cleanSplitPipeline` via `pnpm run runner:chunks`, `ladderPipeline` via `runner:ladder`, `tokenLadderPipeline` via `runner:tokens` writing `out/token-ladder-summary.md`) |
| sample3 | `samples/sample3` | Multi-tool pipeline: JSONL → tools → subflows → batch → MD output |
| sample4 | `samples/sample4` | Book flow in three chained stages: raw JSONL -> normalize -> summary/glossary/`<term>` tagging -> line-by-line EN->RU with a parity linter; plus secret-backend demos (embed/keepass/vlt) |
| sample5 | `samples/sample5` | One tiny pipeline per LLM-backed tool (summary, translate modes, typo-fix, glossary, statdata, ...) with a side-by-side report in `out/<tool>/`; remote ollama via gitignored `mt.local.json` |

Adding a new sample: see [adding-a-sample.md](adding-a-sample.md).

Integration tests for samples live under `samples/sample*/tests/` and are part of the
pre-merge gate (see [change-workflow.md](../change-workflow.md)).

## LLM backend of a sample

`sample3` and `sample4` route every LLM-backed tool through one pick (`pickLlmTool` from `@mt/tools`;
sample3 installs the mock process-wide via `defineProcess().install(mockLlm(...))` instead of wiring it
per tool — see [mock-tools.md](mock-tools.md)):
`MT_LLM_TOOL` (`router` | `openrouter-free` | `openrouter-pool` | `ollama` | `mock`) selects the
backend and `MT_LLM_MODEL` the model; `mt.json` → `settings.llm.tool` / `settings.llm.model` are the
file-based fallback (the env wins). The default is the offline `mock` backend, so the sample tests
need no credentials — swap the backend without touching the pipeline.

`sample5` runs every LLM-backed tool on its own against a remote ollama: put the endpoint and model in the
gitignored `samples/sample5/mt.local.json` (imported by `mt.json`, see its README); the tests force `mock`.

In `sample4` each stage has one further switch of its own, off by default: `MT_LLM_TYPO_FIX=1` (normalize)
and `MT_LLM_SUMMARY=1` (analyze) add the LLM step; the `mock` backend answers with fake Cyrillic so
`translate` runs end to end offline, and `MT_TRANSLATE_PROMPT_LOG` dumps every prompt for the test.

## Running a sample manually

Requires packing local deps first:

```bash
cd samples/sample3
pnpm -C ../../packages/core pack --pack-destination ./vendor
pnpm -C ../../packages/cli pack --pack-destination ./vendor
npm install --no-audit --no-fund
pnpm run runner
```
