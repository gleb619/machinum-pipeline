# T202 — mt serve auth: MT_SERVE_TOKEN bearer on admin API

## Keywords

Keywords: MT_SERVE_TOKEN, mt serve, serve.ts, standalone.ts, createBackendApp, bearer, timingSafeEqual, bind-guard, assertSafeBind, isLoopbackHost, vlt, embed, middleware

## Goal

Idea "Gaps: Auth". Admin API (`packages/webui/server/routes/api/**`) has no auth. Router has `MT_ROUTER_TOKEN` + `packages/router/server/utils/bind-guard.ts` (`assertSafeBind`, `isLoopbackHost`) + `packages/router/server/middleware/auth.ts`; `packages/tools/src/modification/browser-translate-server.ts` uses `timingSafeEqual`. Add the same for `mt serve`: `Authorization: Bearer <token>` required on `/api/*` when a token is configured; token **mandatory** when `--host` is non-loopback (refuse to start, with fix hint). Foundation for T203/T204/T205.

Layer rule: router is standalone (zero `@mt/*`), so **copy** the small loopback/bind guard into `packages/webui/server/utils/` (do not import router). Token resolution reuses the core vault ref machinery (`vlt:`/`keepass:`/`embed:`; find resolver via `packages/core/src/config.ts` + vault code) so `MT_SERVE_TOKEN=embed:serve-token` works; plain env also fine.

Defaults chosen (open questions):
- Token source order: `startBackend({ token })` (from CLI) > `MT_SERVE_TOKEN` env > `mt.json -> serve.tokenRef` (a ref, never plaintext). CLI flag `--token-ref <ENV_OR_REF>`; NO `--token <plaintext>` flag (shell history / process list leak).
- Loopback host + no token = open (back-compat). Non-loopback + no token = startup error.
- Exempt: static UI GETs (non-`/api/`) and `GET /api/health` (returns only `{status:'ok'}` unauthenticated; richer payload in T203 only when authenticated).
- 401 body `{ error: 'Unauthorized' }`, header `WWW-Authenticate: Bearer`; compare SHA-256 digests with `timingSafeEqual` (no length leak). Token never logged.
- Web UI / TUI / Chrome ext token input: out of scope, document curl/CLI usage; log follow-up if components fetch wrapper needs header.
- TLS: docs only (SSH tunnel / reverse proxy).

## Time

<!-- Planned: the planning agent's commitment (>= 2m per step). Estimated: written by `at kanban estimate` — do not edit. -->
Planned: 3h
Estimated: 3h

## Files to touch

- new `packages/webui/server/utils/serve-auth.ts` (`isLoopbackHost`, `assertSafeServeBind`, `checkBearer`, `resolveServeToken`)
- `packages/webui/server/standalone.ts`: `StartBackendOptions.token`, h3 middleware before the router in `createBackendApp`, bind guard in `startBackend`
- Nitro dev path: add `server/middleware/` equivalent only if Nitro dev is still supported (check `nitro.config.ts`); else note in doc
- `packages/cli/src/commands/serve.ts`: parse `--token-ref`, resolve, pass through; `detachServe` must forward the ref (not plaintext) in argv/env
- Tests: new `packages/webui/tests/serve-auth.test.ts`; extend `standalone.test.ts`, `packages/cli/tests/commands/serve.arch.test.ts`; `routes.arch.test.ts` + `layers.arch.test.ts` stay green
- Docs: `docs/steering/webui.md` (Auth section), `docs/steering/cli.md` (serve flags), `docs/steering/tech.md` env table (`MT_SERVE_TOKEN`), `docs/guiding/installation.md` (remote serve hardening), idea doc
- `docs/SKILL.md`: new flag + env + config key = mandatory update; bump `skill-version` + date, `pnpm --filter=@mt/cli gen:skill`, verify `mt skill`

## Steps

- [ ] Read webui.md, cli.md, router `auth.ts` + `bind-guard.ts` + their tests (mirror)
- [ ] Failing tests: loopback no token open; non-loopback no token throws; token set: 401 no header, 401 wrong, 200 right; `/api/health` open; static GET open; different-length token path; vault ref resolved
- [ ] Implement util + middleware + startBackend wiring
- [ ] CLI flag/env/config wiring; detach path safe
- [ ] Docs + SKILL.md + gen:skill
- [ ] Gates; `pnpm build:bin && pnpm smoke:bin` (manual curl with/without token)

## Done when

- webui + cli tests green; skill drift test green
- lint, typecheck, samples IT, test:gpu, ci:local reported

Gates (report all before FF-merge, per docs/change-workflow.md): `pnpm lint`, `pnpm typecheck`, `pnpm test` (scoped first), samples IT, `pnpm test:gpu` (needs `MT_OLLAMA_URL`; unreachable = report failure, never skip), `pnpm ci:local`. Embedded packages changed -> `pnpm build:bin && pnpm smoke:bin`. Logging only via `ctx.run.logger` / `DuplexLogger` / `createConsoleLogger()`. Atomic writes. No AI attribution trailers.

Deps: none. Blocks T203, T204, T205.
