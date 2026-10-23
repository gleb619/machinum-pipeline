# Adding a new sample

Samples = runnable mini-projects showing how to work with `mt`. Each doubles as an integration test
(pre-merge gate, see [change-workflow.md](change-workflow.md)). Index: [samples.md](samples.md).

## Existing samples (reference)

| Sample | Shows | Look at |
|---|---|---|
| `sample0` | `mt init` scaffolding, asserts generated files | `tests/init.test.ts` |
| `sample1` | `hs://` HTTP source → `jsonl://` target; 2nd pipeline `jsonl://` → `chapterDoc` → `md://`; external client script | `pipelines/`, `simulation1.ts`, `run-example.ts`, `tests/full-flow.test.ts` |
| `sample2` | Multi-tool pipeline: custom `defineTool`, `.flatMap/.tap/.batch`, `.subflow()`, named pipeline exports (`--pipeline <name>`), `ephemeral://` | `pipelines/jsonl-to-md-multi.ts`, `prepare-input.ts` |

Shared sample data: `books/book1/chapter-N.en.md` (repo root).

## Layout

```
samples/sampleN/
├── package.json        # scripts + workspace deps
├── mt.json             # project config (skip for init-style samples)
├── vitest.config.ts    # copy from sample1/sample2
├── README.md           # what you learn, layout, run/cleanup/manual steps, how test works
├── pipelines/*.ts      # default-export definePipeline(...)
├── tests/*.test.ts     # integration tests (required)
├── jsonl/.gitkeep      # runtime dirs kept via .gitkeep; outputs gitignored/cleaned
└── (optional) prepare-input.ts, simulation*.ts, run-example.ts
```

## Steps

1. **Pick name + goal.** Next free `sampleN`. One concept per sample (one new URI scheme, DSL op, or tool group).
2. **Work in a worktree/branch**, never `main` ([change-workflow.md](change-workflow.md)).
3. **`package.json`** — copy sample2's. Keep `"type": "module"`, `engines.node >=22`. Deps use
   `workspace:*` (`@mt/core`, `@mt/cli`, `@mt/waypoint`, plus `@mt/tools` if used); dev deps `tsx`, `vitest`.
   Scripts:
   - `runner` — `NODE_OPTIONS='--import tsx' mt run ./pipelines/<file>.ts`
   - `example` — one-command demo (prepare input + run)
   - `cleanup` — `rm -rf` every generated output + `.mt`
   - `test` / `test:watch` — `vitest run` / `vitest`
4. **`mt.json`** — `{ "project": { "name": "sampleN" }, "defaults": { retry, onError, concurrency } }` (copy sample1).
5. **`vitest.config.ts`** — `include: ['tests/**/*.test.ts']`, `fileParallelism: false`, timeouts 15–20s.
6. **Pipeline** in `pipelines/`: string URIs preferred, `import '@mt/waypoint'` for side-effect scheme registration.
   ```ts
   import { definePipeline } from '@mt/core'
   import '@mt/waypoint'

   export default definePipeline()
     .from('jsonl://./jsonl/input.jsonl')
     .to('md://./chapters/en')
   ```
   Extra pipelines → named exports; run with `mt run <file> --pipeline <name>`.
7. **Input data** — reuse `books/book1` via a `prepare-input.ts` (sample2) or HTTP client script (sample1).
   Never commit generated output; commit `.gitkeep` for runtime dirs.
8. **Integration test** (pattern identical across samples):
   - `SAMPLE_DIR = resolve(import.meta.dirname, '..')`, `MT_BIN = <SAMPLE_DIR>/node_modules/.bin/mt`
   - `beforeAll`: `cleanup()` + write small fixed input
   - test: `execSync('"MT_BIN" run ./pipelines/x.ts', { cwd: SAMPLE_DIR, env: { ...process.env, NODE_OPTIONS: '--import tsx' }, timeout })`
   - assert on output files (content, order, count)
   - `afterAll`: cleanup only if no test failed (keeps artifacts for debugging)
   - Test must be deterministic: no network, no LLM. Stub tools (`defineTool` in-proc) instead.
9. **README.md** — mirror existing: *What you will learn*, *Directory layout*, *How to run*
   (`npm run example`), *How to clean up*, *How to run manually*, *How the test works*.
10. **Register** — add a row to [samples.md](samples.md). Workspace glob `samples/*` already picks it up;
    run `pnpm install` to link.

## Verify (gate)

```bash
pnpm install
pnpm --filter=sampleN test          # new sample IT
pnpm lint && pnpm typecheck
pnpm test                           # all samples still green
```

## Rules

- Sample = teaching material: small, readable, one idea, comments only where the DSL isn't obvious.
- No secrets / API keys; no external services in tests.
- Output dirs must be wiped by `cleanup` script and test `cleanup()`.
- Don't import from `packages/*/src` — only package names (`@mt/*`).
