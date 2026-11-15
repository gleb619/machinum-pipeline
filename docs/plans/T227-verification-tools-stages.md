# T227 — Refactor verification tools to defineStage/wrap stage chains

## Goal

Tools in `packages/tools/src/verification/` (chapter-validator family) express their
check pipeline as `wrap()`/`defineStage()` chains so each validator/check is a named
stage: per-stage timing in metrics, `StageError` attribution on failure, and
fine-grained checkpoints.

## Scope

1. Validator orchestration: chapter load → per-check stages (structure, schema,
   metadata, language checks) → report assembly.
2. Each individual check = one `defineStage`; report builder = final stage.
3. Skip single-phase tools; no behavior change; tests green.

## Steps

1. Refactor validator orchestration to stages; interception test (check names +
   order + failure attribution).
2. Roll through remaining verification tools.
3. Gates: `pnpm --filter=@mt/tools test`, typecheck, lint; sample IT.
4. Note in docs/steering/tools.md.

## Time

Planned: 4h

## Done when

- Verification tools run as stage chains; failing check surfaces stage name via
  StageError; tests green.

<!-- provenance: row=T227 -->
<!-- provenance: row=19f0d86d1b55 layout=347ba342e2da -->
