# T205 — `mt worker` mode (dial-out pull worker)

## Keywords

Keywords: mt worker, /api/workers, signals SSE, Last-Event-ID, max-runs, drain, spawn child mt, worker mirror, .mt/worker, pull sync, runner-registry, mt run --on

## Goal

Idea section 1c. Worker process on the remote dials out to main `mt serve`: register, mirror project (T203 pull direction), hold SSE control channel, spawn one child `mt` processor per `run` signal, report events back, `drain` finishes then exits. Main side creates the run record and mirrors state/events so `mt ls runs`, `mt inspect`, webui, TUI work unchanged. Data ingress is declared by the pipe only (workers open no listener by default).

Defaults chosen (open questions):
- Default mode: worker/pull is the default remote story; push (T203/T204) stays for dev loop.
- Worker trust: per-worker token = the shared `MT_SERVE_TOKEN` in phase 1 (simple); `--allow-pipeline <glob>` (repeatable) on `mt worker` restricts runnable pipeline paths, default allow `pipelines/**`. Per-worker tokens + main-side allow-list = follow-up, noted.
- Transport: SSE `GET /api/workers/:id/signals` (+ 25 s heartbeat comment, `Last-Event-ID` replay from an in-memory ring of 200 signals), long-poll fallback `GET /api/workers/:id/signals?wait=25` for proxies. Worker->main events: `POST /api/runs/:id/events` batches (NDJSON, <=500 lines / 1 s) written by main into its own `.mt/runs/<id>/events.jsonl` so existing tail/SSE works. Targets written on worker pulled by main via T203 pull scope.
- Worker registry on main: in-memory + `.mt/workers/<id>.json` (atomic) for listing; heartbeat TTL 60 s -> `lost`; runs of lost worker marked `paused` (resumable), never silently failed.
- Spawn: child = same binary (`process.execPath` + argv rule from `serve.ts detachServe`: compiled Bun binary vs node script) running `mt run <pipeline> --run-id <id> --report-to <mainUrl>` in the mirror root; `--max-runs` default 1; crash of child -> report `failed`, worker survives.
- Signals set phase 1: `project-changed`, `run {runId, pipeline, params}`, `pause`, `resume`, `cancel`, `drain`.
- Run routing: `mt run p.ts --on <name>` / `--remote` (no URL, tags) selection is in this task (main-side `POST /api/runs/start` with `worker`/`tags`), but only once T204 flags exist.
- Ingest forwarding for `hs://` in a worker child uses T201 forward path when available; if T201 not landed, worker children bind own port (documented limitation).
- UI: "Workers" view = follow-up task (docs/layout.md contract); API listing `GET /api/workers` ships here.

## Time

<!-- Planned: the planning agent's commitment (>= 2m per step). Estimated: written by `at kanban estimate` — do not edit. -->
Planned: 10h

## Files to touch

- webui: `routes/api/workers/{index,[id]/signals,[id]/heartbeat}.ts`, `routes/api/runs/[id]/events.ts` POST handler (ingest from worker; currently GET SSE), `server/utils/worker-registry.ts`, `standalone.ts` router registration, `start.ts` (`worker`/`tags` routing -> signal instead of local Runner)
- cli: new `packages/cli/src/commands/worker.ts` (`mt worker --main URL --token-ref REF [--name] [--tag a,b] [--max-runs N] [--allow-pipeline GLOB]`), register in `index.ts`; `run.ts` gains `--run-id` / `--report-to` (hidden) for child mode and `--on`
- core: reuse T203 sync lib (pull); maybe small `runIdOverride` in `Runner` options (check `packages/core/src/engine/runner.ts`) - verify first, minimal change
- Tests: worker-registry unit; signals SSE + replay; e2e in-process: main `startBackend` + worker loop with fixture pipeline (mock tool) -> run signal -> child spawned -> events visible on main; drain; crash child; heartbeat loss
- Docs: `docs/steering/cli.md`, `webui.md`, `docs/guiding/architecture.md`, `docs/guiding/remote-run.md` (from T204; add worker section), `docs/layout.md` (Workers view stub), idea doc 1c
- `docs/SKILL.md`: new command + lifecycle = mandatory; bump version/date; gen:skill; verify `mt skill`; drift test green

## Steps

- [ ] Read cli.md, webui.md, serve.ts detachServe spawn logic, runner.ts options, T203/T204 code as landed
- [ ] Failing tests per list above
- [ ] Main: registry + register/heartbeat + signals SSE + event ingest endpoint
- [ ] Worker loop: register, mirror pull, SSE client with reconnect/backoff, signal dispatch, child spawn/supervise, report, drain
- [ ] Main-side routing `--on` / tags
- [ ] Docs + SKILL.md + gen:skill; gates; `pnpm build:bin && pnpm smoke:bin`; manual smoke two terminals

## Done when

- e2e worker test green (register -> run -> events on main -> drain exit 0)
- killed child does not kill worker; lost worker -> runs paused
- lint, typecheck, samples IT, test:gpu, ci:local reported

Gates (report all before FF-merge, per docs/change-workflow.md): `pnpm lint`, `pnpm typecheck`, `pnpm test`, samples IT, `pnpm test:gpu` (unreachable = report failure, never skip), `pnpm ci:local`, `pnpm build:bin && pnpm smoke:bin`. Logging only via logger APIs. No AI attribution trailers.

Deps: blocked by T202, T203; soft after T204 (shared run.ts/start.ts) and T201 (ingest forwarding). Split suggestion if >10h: server side vs worker CLI.
