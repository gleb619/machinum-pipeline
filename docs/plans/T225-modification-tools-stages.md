# T225 — Refactor modification tools to defineStage/wrap stage chains

## Goal

Every multi-step tool in `packages/tools/src/modification/` is rewritten so its
`invoke` runs a `wrap()` chain of small named `defineStage()` functions instead of
one big function body. Stages become interceptable (metrics, checkpoints, debugging)
via `chain.intercept(...)` from `@mt/core` (`wrap.ts`).

Rule: user-facing custom tools keep the plain `defineTool` API — this refactor is
for built-in regular tools only. A tool qualifies when its invoke has ≥2 distinct
sequential phases (parse → transform → serialize, etc.).

## Scope (first targets)

1. `chapter-doc.ts` — the reference refactor: ChapterDoc build/parse pipeline
   becomes explicit stages (frontmatter, body parse, entity extraction, serialize).
2. `book-compiler.ts`, `to-markdown.ts`, `md-formatter-adjacent` flows — same pattern.
3. `chapter-translator.ts`, `browser-translate.ts`, `proofread.ts`,
   `analyze-outputs.ts` — stage the LLM-call wrappers (prompt build → call → parse).
4. Skip single-expression tools; no behavior change, all existing tests green.

## Steps

1. Refactor `chapter-doc.ts` to `defineStage`/`wrap`; add a test asserting stage
   interception fires per stage (names, order, timing payload).
2. Roll the pattern through the remaining modification tools, one file per commit.
3. Verify: `pnpm --filter=@mt/tools test`, typecheck, lint; sample IT green.
4. Steering docs (tools.md): short "staging tools" section with the pattern.

## Time

Planned: 6h

## Done when

- All qualifying modification tools use wrap chains; single-phase tools untouched.
- New test proves per-stage interception on chapter-doc; no regressions.

<!-- provenance: row=T225 -->
