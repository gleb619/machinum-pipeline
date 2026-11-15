# T226 — Refactor normalization tools to defineStage/wrap stage chains

## Goal

Multi-step tools in `packages/tools/src/normalization/` use `wrap()`/`defineStage()`
chains from `@mt/core` so splitting/formatting phases are named, interceptable
stages (metrics + checkpoints). Custom/user tools stay on plain `defineTool`.

## Scope

1. `text-splitter.ts` — stage the strategy pipeline (detect → split → fallback →
   emit); oversized-paragraph fallback becomes its own visible stage (feeds T190).
2. `md-formatter.ts` — stage normalize passes (headings, lists, whitespace).
3. Remaining normalization tools with ≥2 sequential phases; skip trivial ones.
   No behavior change; tests stay green.

## Steps

1. Refactor `text-splitter.ts` to stages + interception test.
2. Refactor `md-formatter.ts` and any other qualifying files.
3. Gates: `pnpm --filter=@mt/tools test`, typecheck, lint; sample IT.
4. Note in docs/steering/tools.md.

## Time

Planned: 4h

## Done when

- Qualifying normalization tools on wrap chains; interception test green; no
  behavior regressions.

<!-- provenance: row=T226 -->
<!-- provenance: row=edb7a119ebd1 layout=347ba342e2da -->
