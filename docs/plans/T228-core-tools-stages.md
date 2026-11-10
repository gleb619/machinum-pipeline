# T228 — Refactor core multi-step tools to defineStage/wrap stage chains

## Goal

Multi-step tools in `packages/tools/src/core/` use `wrap()`/`defineStage()` where a
clear sequential stage sequence exists — primarily the LLM-call wrappers — so
prompt-build → call → parse/validate are interceptable stages (metrics, token/cost
attribution, retries per stage). Pure infra helpers (caches, pools, limiters) stay
plain functions.

## Scope

1. `translate-text.ts`, `ollama-tool.ts`, `openrouter-tool.ts` — stage:
   prompt assembly → context build → LLM call → response parse/validate.
2. `chunk-processor.ts` — stage per-chunk processing loop.
3. Explicitly out of scope: `llm-pool.ts`, `lru-cache.ts`, `limiter.ts` (no stage
   sequence), and anything already thin.

## Steps

1. Refactor `translate-text.ts` as the reference; interception test asserting
   stage timing on the LLM call stage.
2. Roll to `ollama-tool.ts` / `openrouter-tool.ts` / `chunk-processor.ts`.
3. Gates: `pnpm --filter=@mt/tools test`, typecheck, lint; sample IT.
4. Note in docs/steering/tools.md.

## Time

Planned: 5h

## Done when

- LLM-call tools expose prompt/call/parse stages with per-stage metrics; infra
  helpers untouched; tests green.

<!-- provenance: row=T228 -->
