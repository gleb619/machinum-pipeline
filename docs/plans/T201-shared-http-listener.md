# T201 — Shared HTTP listener registry (hs:// reuses mt serve port)

## Keywords

Keywords: acquireListener, listener registry, http-server.ts, EADDRINUSE, startBackend, standalone.ts, createBackendApp, hs://, ingest, refcount, runner-registry.ts

## Goal

Idea section 1d. Today `createHttpSource` does `createServer().listen(port, '127.0.0.1')` (http-server.ts ~L112/L218) so `hs://` on the `mt serve` port dies with EADDRINUSE. Add a per-process refcounted listener registry so several `hs://` sources (and `mt serve`) share one `http.Server` per `host:port`; and a cross-process forward path for spawned processors.

Layer problem (decision): waypoint must not import webui (and webui must not import waypoint beyond what layers allow; check `packages/webui/tests/layers.arch.test.ts`, `docs/steering/structure.md`). So the registry lives in **`@mt/core`** (`packages/core/src/http-listener.ts`, exported): `acquireListener(host, port, factory?) -> { server, release(), addRoute(path, handler) }`. waypoint and webui both depend on core already. Confirm with arch tests before coding.

Defaults chosen for open questions:
- Phase scope: in-process sharing + route mount on `mt serve` (steps 1-5). Cross-process forwarding via **parent HTTP reverse-proxy route** (`POST /api/ingest/register {path, runId, targetUrl}`, parent forwards body to child's loopback port) — chosen over IPC/unix socket (works the same under Node and Bun binary, testable with plain http). Implement as last step; may be split to a follow-up task if it grows.
- Host match: same port and (hosts equal OR existing bound to `0.0.0.0`/`::` covering a loopback request). Different explicit interfaces on one port stay separate; mismatch -> own listener, as today.
- Ingest paths colliding with `/api/*` are rejected at `open()` with a clear message. Ingest mounts under the pipeline-declared path only (default `/ingest`).
- Foreign process on the port -> unchanged clear error (EADDRINUSE message with host:port).
- Keep 503 + `Retry-After` backpressure and `/events`, `/health` semantics per source; when shared, `/events` and `/health` are namespaced under the ingest path prefix to avoid clobbering admin `/api/health`.
- Default bind stays `127.0.0.1` for sources; no auth change here (see T202).

## Time

<!-- Planned: the planning agent's commitment (>= 2m per step). Estimated: written by `at kanban estimate` — do not edit. -->
Planned: 5h

## Files to touch

- new `packages/core/src/http-listener.ts` + export in `packages/core/src/index.ts`; tests `packages/core/tests/http-listener.test.ts`
- `packages/waypoint/src/http-server.ts`: replace direct `createServer/listen` with `acquireListener`; route table instead of one monolithic handler; release in `close()`/pause/failed
- `packages/webui/server/standalone.ts`: `startBackend` registers its server (replace `createServer` at ~L121) via the registry; `createBackendApp` exposes a mount hook; new `routes/api/ingest/register.ts` for cross-process
- `packages/webui/tests/standalone.test.ts`, `packages/waypoint/tests/builtins/http-server*.test.ts` (find the existing one), samples/sample1 IT must stay green
- Docs: `docs/steering/waypoint.md` (hs:// lifecycle), `docs/steering/webui.md` (ingest mount + register route), `docs/steering/core.md` (listener registry), `docs/guiding/architecture.md` if ports are described; idea doc 1d -> implemented
- `docs/SKILL.md`: review (hs:// + mt serve behaviour change); bump version only if user-visible text changes; if bumped, gen:skill

## Steps

- [ ] Read waypoint.md, webui.md, structure.md, layers arch tests; confirm registry home (core)
- [ ] Failing tests: two hs:// sources one port share it; refcount closes on last release; hs:// + running `startBackend` same port both answer; `/api/*` collision rejected; foreign-process conflict still fails clearly; pause/resume removes/readds route
- [ ] Implement registry in core
- [ ] Refactor createHttpSource onto registry (behaviour-preserving; sample1 IT)
- [ ] Refactor startBackend onto registry; ingest mount hook
- [ ] Cross-process: `POST /api/ingest/register` + forwarder + child-side source mode (env `MT_INGEST_PARENT`); test with spawned fixture
- [ ] Docs; gates; `pnpm build:bin && pnpm smoke:bin`

## Done when

- new registry + waypoint + webui tests green; samples IT green
- lint, typecheck, test:gpu, ci:local reported

Gates (all must be reported before FF-merge, per docs/change-workflow.md): `pnpm lint`, `pnpm typecheck`, `pnpm test` (scoped first), samples IT (`samples/sample*/tests/`), `pnpm test:gpu` (needs `MT_OLLAMA_URL`; unreachable = report failure, never skip), `pnpm ci:local`. Packages embedded in the binary changed -> `pnpm build:bin && pnpm smoke:bin`. Logging: only `ctx.run.logger` / `DuplexLogger` / `createConsoleLogger()`, never `console.*`. Atomic writes (temp-then-rename). No `Co-Authored-By`.

Deps: none hard. Prefer to land before T205 (worker) which consumes the forward path. Touches http-server.ts like T200.
