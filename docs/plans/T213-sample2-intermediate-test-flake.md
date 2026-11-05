# T213 — sample2 intermediate: share one pipeline run, raise exec timeout

## Keywords

Keywords: samples/sample2/tests/intermediate.test.ts, ETIMEDOUT, beforeAll, execSync timeout

## Goal

`samples/sample2/tests/intermediate.test.ts` calls `run()` (full `mt run` via `execSync`,
`timeout: 10_000`) inside **every** `it`. Under load (full sample2 suite, parallel agents,
cold binary) individual cases hit `spawnSync ETIMEDOUT` even though the pipeline is fine when
run alone. Fix flake: one shared run per file, and a timeout that matches real wall time.

## Steps

- [ ] Hoist `run()` into `beforeAll` (or first test with a module-level cached `content` /
      `output`); all `it`s read the same `parallel-forks.md`
- [ ] Raise `execSync` timeout (e.g. 30–60s) so a slow-but-healthy run does not fail the suite
- [ ] Confirm `pnpm --filter=sample2 test` is green under concurrent load (or at least that
      intermediate no longer ETIMEDOUT when other sample2 tests run in the same vitest process)

## Time

<!-- Planned: the planning agent's commitment (>= 2m per step). Estimated: written by `at kanban estimate` — do not edit. -->
Planned: 20m
Estimated: -

## Done when

- Intermediate tests invoke `mt run` at most once per file
- `pnpm --filter=sample2 exec vitest run tests/intermediate.test.ts` still green
- Full `pnpm --filter=sample2 test` does not fail intermediate with `ETIMEDOUT`

<!-- provenance: row=83ced418ba63 layout=fb348817cbf5 -->
