# Samples

| Sample  | Path              | What it demonstrates                                          |
|---------|-------------------|---------------------------------------------------------------|
| sample0 | `samples/sample0` | `mt init` integration test — validates scaffolded artifacts   |
| sample1 | `samples/sample1` | HTTP → JSONL pipeline (`hs://` source, `jsonl://` target)     |
| sample2 | `samples/sample2` | Multi-tool pipeline: JSONL → tools → fork → batch → MD output |

Adding a new sample: see [adding-a-sample.md](adding-a-sample.md).

Integration tests for samples live under `samples/sample*/tests/` and are part of the
pre-merge gate (see [change-workflow.md](change-workflow.md)).

## Running a sample manually

Requires packing local deps first:

```bash
cd samples/sample2
pnpm -C ../../packages/core pack --pack-destination ./vendor
pnpm -C ../../packages/cli pack --pack-destination ./vendor
npm install --no-audit --no-fund
pnpm run runner
```
