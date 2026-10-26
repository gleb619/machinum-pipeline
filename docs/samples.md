# Samples

| Sample  | Path              | What it demonstrates                                          |
|---------|-------------------|---------------------------------------------------------------|
| sample0 | `samples/sample0` | `mt init` integration test — validates scaffolded artifacts   |
| sample1 | `samples/sample1` | HTTP → JSONL pipeline (`hs://` source, `jsonl://` target)     |
| sample2 | `samples/sample2` | Multi-tool pipeline: JSONL → tools → fork → batch → MD output |
| sample3 | `samples/sample3` | Basic Markdown processing: sources, events, fork/subflow, range:// and void:// |
| sample4 | `samples/sample4` | Book flow in three chained stages: raw JSONL -> normalize -> summary/glossary/`<term>` tagging -> line-by-line EN->RU with a parity linter |

Adding a new sample: see [adding-a-sample.md](adding-a-sample.md).

Integration tests for samples live under `samples/sample*/tests/` and are part of the
pre-merge gate (see [change-workflow.md](change-workflow.md)).

## LLM backend of a sample

`sample2` and `sample4` route every LLM-backed tool through one pick (`samples/sampleN/pipelines/llm-picker.ts`):
`MT_LLM_TOOL` (`router` | `openrouter-free` | `openrouter-pool` | `ollama` | `mock`) selects the
backend and `MT_LLM_MODEL` the model; `mt.json` → `settings.llm.tool` / `settings.llm.model` are the
file-based fallback (the env wins). The default is the offline `mock` backend, so the sample tests
need no credentials — swap the backend without touching the pipeline.

In `sample4` each stage has one further switch of its own, off by default: `MT_LLM_TYPO_FIX=1` (normalize)
and `MT_LLM_SUMMARY=1` (analyze) add the LLM step; the `mock` backend answers with fake Cyrillic so
`translate` runs end to end offline, and `MT_TRANSLATE_PROMPT_LOG` dumps every prompt for the test.

## Running a sample manually

Requires packing local deps first:

```bash
cd samples/sample2
pnpm -C ../../packages/core pack --pack-destination ./vendor
pnpm -C ../../packages/cli pack --pack-destination ./vendor
npm install --no-audit --no-fund
pnpm run runner
```
