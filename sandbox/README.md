# sandbox - translation model bench

Custom e2e playground (T104): pick the best model for EN->RU book translation.
Not in `pnpm-workspace.yaml`, not in turbo or `pnpm test` gates.

## Setup (once)

```bash
pnpm --dir sandbox install --ignore-workspace   # tsx, vitest (own node_modules)
pnpm build                                      # repo packages must be built (@mt/core dist)
```

`src/bench.ts` imports `../../packages/tools/src/index.ts` by relative path.

## Run

```bash
pnpm --dir sandbox bench:mock                   # offline, mockLlmCall
pnpm --dir sandbox bench --tool ollama --models gemma4:latest,gpt-oss:20b --runs 2
pnpm --dir sandbox bench --tool openrouter-free --models openrouter/free --runs 1
pnpm --dir sandbox test                         # scoring unit tests
```

Options: `--tool ollama|openrouter-free|openrouter-pool|mock`, `--models a,b,c`, `--runs N`,
`--out results/`.

- ollama endpoint: `MT_OLLAMA_URL` (default `http://localhost:11434/v1`; set it to your GPU server)
- openrouter: `OPENROUTER_API_KEYS` / `OPENROUTER_API_KEY`
- Models on the GPU server: gemma4:latest, gemma4:31b, gpt-oss:20b, qwen3.8:latest, deepseek-r1:32b

## Output

`results/<timestamp>.json` (raw, per paragraph) and `results/report.md` (ranked table). Both gitignored.

Score 0..1 = 0.3 line parity + 0.3 glossary hits + 0.4 cyrillic ratio; empty/echo output = 0.
Fixture and glossary live in `src/fixture.ts`; scoring in `src/score.ts`.
