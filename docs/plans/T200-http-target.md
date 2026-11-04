# T200 — http:// / https:// waypoint target (?method=)

## Keywords

Keywords: WT003, http-server.ts, registerTarget, createHttpTarget, jsonl.ts, md.ts, waypoint(), direction target, bearer, retries, Retry-After, X-MT-Exchange-Id, checkpoint

## Goal

Idea: `docs/ideas/hs-target-and-localhost-translate.md` section 1b. Register `http` and `https` as **targets** (client role) next to the existing source. `hs://` stays source-only (no `registerTarget('hs')`). `.from('http://')` still listens; `.to('http://…')` sends. WT003 gets a second annotation (`direction: 'target'`) like `packages/waypoint/src/jsonl.ts` (WT001 x2). Layer: waypoint only; zero new deps (use global `fetch`).

Defaults chosen for open questions (conservative):
- `?capture=<variable>` is **out of scope** (terminal target, response body discarded). Note stays in idea doc.
- `bearer=<NAME>` resolves through `process.env` / `ctx.global` secrets (same resolver tools use for `apiKey`; reuse, do not invent). Unresolvable ref = fail at `open()` with clear message. Never inline plaintext; reject values that look like a token (contain `.`/length > 64 and not an env-name pattern `^[A-Z_][A-Z0-9_]*$`).
- Only `http:`/`https:` hosts; no redirect following to a different origin (`redirect: 'manual'`, treat 3xx as failure).
- Retry: network error, 429, 5xx; exponential backoff (reuse `getBackoff`/`withRetry` from core if exported, else local); honour `Retry-After`; 4xx (not 429) = item fails -> dead-letter path like other targets.
- Query secrets masked in every log line (reuse `packages/cli/src/utils/mask.ts` logic or add small local `maskUrl`; waypoint cannot import cli).

## Time

<!-- Planned: the planning agent's commitment (>= 2m per step). Estimated: written by `at kanban estimate` — do not edit. -->
Planned: 3h

## Files to touch

- `packages/waypoint/src/http-server.ts` (or new `http-target.ts`, preferred; export from `index.ts`): `createHttpTarget(uri)`, `registry.registerTarget('http'|'https', …)`, second `waypoint('WT003', { direction: 'target', … })`.
- `packages/waypoint/src/index.ts` (side-effect import if new file).
- Tests: `packages/waypoint/tests/builtins/http-target.test.ts` (local `node:http` server fixture on port 0; no network). Look at existing `tests/builtins/` for the Target test harness.
- `packages/waypoint/tests/annotations.test.ts`: WT003 now has source + target.
- Docs: `docs/steering/waypoint.md` (line ~20 WT003 row -> `✓ ✓` for http; WP003 matrix ~323/341; add a "http target" section with the param table), `docs/steering/tools.md` (~473 "`hs://` is **ingest-only**" -> point to `.to('http://…')` for outbound), `samples/sample1/README.md` (one sentence), `docs/guiding/architecture.md` URI table if listed. Idea doc: mark 1b "Implemented" with date.
- `docs/SKILL.md`: new URI target scheme = mandatory review. Add `.to('http://…')` to URI scheme table, bump `skill-version` + date, `pnpm --filter=@mt/cli gen:skill`, verify `mt skill`; drift test `packages/cli/tests/commands/skill.test.ts` must pass.

## Steps

- [ ] Read `docs/steering/waypoint.md`, `docs/steering/structure.md`, `packages/waypoint/src/jsonl.ts` (target shape: `open/write/checkpoint/close`), `http-server.ts`
- [ ] Failing tests first: POST default + JSON Exchange body; `X-MT-Exchange-Id` header; `method=PUT|PATCH|DELETE`; `method=GET|HEAD` rejected at parse; `contentType=item|text`; `batch=true` one request per batch with `items[]`; `header.X-Foo`; bearer ref -> `Authorization`; missing ref fails open(); retries on 503 then success; `Retry-After`; 400 fails item, no retry; timeout; secret query masked in logs; checkpoint counts only 2xx-acked
- [ ] Implement `createHttpTarget` with `fetch` + `AbortSignal.timeout(timeoutMs)`
- [ ] Register `http` + `https`; WT003 second annotation; `hs` NOT registered as target (assert in test: `resolveTarget('hs://…')` throws)
- [ ] Docs + SKILL.md + gen:skill (see Files)
- [ ] Gates + `pnpm build:bin && pnpm smoke:bin`

## Done when

- `pnpm --filter=@mt/waypoint exec vitest run tests/builtins/http-target` green
- `pnpm annotations --kind waypoint` lists WT003 with source+target
- skill drift test green; lint, typecheck, samples IT, test:gpu, ci:local reported

Gates (all must be reported before FF-merge, per docs/change-workflow.md): `pnpm lint`, `pnpm typecheck`, `pnpm test` (scoped first), samples IT (`samples/sample*/tests/`), `pnpm test:gpu` (needs `MT_OLLAMA_URL`; unreachable = report failure, never skip), `pnpm ci:local`. Packages embedded in the binary changed -> `pnpm build:bin && pnpm smoke:bin`. Logging: only `ctx.run.logger` / `DuplexLogger` / `createConsoleLogger()`, never `console.*`. Atomic writes (temp-then-rename). No `Co-Authored-By`.

Deps: none (independent). Related: T201 (shared listener) touches the same http-server.ts; rebase carefully.
