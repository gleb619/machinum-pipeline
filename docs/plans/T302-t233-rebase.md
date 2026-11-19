# T302 — Rebase T233 translation retune onto the tools refactor

## Keywords

Keywords: packages/tools/src/normalization/translation-stage.ts, samples/sample2-practical/pipelines/translate-chapters.ts, samples/sample2-practical/tests/translate-chapters.test.ts, blockSize, blockLines, feat/t233

## Goal

`feat/t233` ("Retune translate block size: 40 drifts on free models, 6 is clean") no longer rebases onto `main` after the
bookkit→tools refactor (`783c946`). Port the intent by hand or re-implement it; do not merge the stale branch as-is.

## Context

- `translation-stage.ts`: T233 introduces `blockSize` + `onBlockFallback`; main has `blockLines` + `onStats`.
- `samples/sample2-practical/pipelines/translate-chapters.ts`: deleted on main; T233's new tests call that path.
- `translate-chapters.test.ts`: text conflict only, but the T233 tests target the removed pipeline.

## Time

Planned: 2h

## Steps

- [ ] Re-read T233 (`git show e826de9`) and the current translation stage API on `main`.
- [ ] Decide the surviving API name (`blockLines` is the main contract) and port the measured-safe default (6) + warning.
- [ ] Re-point T233's tests at `pipelines/translation.ts` / `translateChapters`.
- [ ] Run `pnpm --filter @mt/tools test`, sample2 `translate-chapters` test, `pnpm typecheck`, `pnpm lint`.
- [ ] Delete `feat/t233` only after the port lands on `main`.

## Done when

T233's behaviour (default 6, explicit override wins, one warning above the safe size) is tested on `main` and
`feat/t233` contains no unique work.
