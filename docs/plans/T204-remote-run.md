# T204 — Remote run: mt run --remote / mt resume --remote

## Keywords

Keywords: mt run --remote, mt resume --remote, projectId, /api/runs/start, artifacts, /api/runs/:id/artifacts, SSE events, DuplexLogger, runner-registry, pause, Ctrl+C, run.ts, resume.ts, start.ts

## Goal

Idea section 1 user story. `mt run translate.ts --remote http://remote:7777`: (1) health/version/capability check, (2) sync push (T203), (3) start run on the remote by `projectId`, (4) stream `/api/runs/:id/events` SSE into the local `DuplexLogger`, (5) on terminal state pull artifacts back, (6) Ctrl+C = remote pause. `mt resume <runId> --remote URL` re-attaches. Remote runs are detached from the CLI process.

Defaults chosen (open questions):
- CLI shape: flags on existing commands (`mt run --remote <url>`, `mt resume --remote <url>`); `remote.url` / `remote.tokenRef` in `mt.json` act as default only when `--remote` is passed without value. Plain `mt run` never goes remote implicitly. Explicit-only keeps local behaviour unchanged. `mt remote ...` subcommands (T203) remain for sync/status.
- Start API: `POST /api/runs/start` body gains optional `projectId` (+ `pipeline` relative path, `pipelineName?`); when `projectId` given, `process.cwd()`/`loadGlobalContext` root becomes the mirror `.mt/remote/<projectId>/` (replace the hard-coded `process.cwd()` in `packages/webui/server/routes/api/runs/start.ts` with a root resolver; confinement via `resolveInsideRoot` against the mirror). Without `projectId` behaviour is unchanged. Concurrency: one active run per projectId by default (409), TTL cleanup of idle mirrors: out of scope (documented).
- Secrets never shipped; remote resolves own vault refs. Remote missing a ref -> run fails with message surfaced through SSE.
- Artifacts: `GET /api/runs/:id/artifacts` returns T203 manifest (`scope=outputs&runId=`) and client pulls via sync pull; no tar endpoint. Pull happens incrementally every 5 s while running (partial results) and once more on terminal state. Pull scope = target outputs + `.mt/runs/<id>/` only.
- Local-only sources (e.g. `jsonl://./in.jsonl`) travel as part of sync scope when relative inside project; absolute / outside-root = error before starting ("input not shippable"), large-input streaming = non-goal.
- Exit code mirrors remote terminal state (done=0, failed=1, paused=2-style as local run does; match `run.ts`). Ctrl+C: first = `POST /pause` and exit after ack; second = detach immediately. Print `Resume: mt resume <id> --remote <url>`.
- Local `.mt/runs/<id>/` mirror created from pulled files so `mt ls runs`, `mt inspect` work locally.
- Fail fast: capability check compares pipeline tool prerequisites (browserTranslate -> chrome, container tools -> docker, playwright) via `/api/health.capabilities`; unknown tools skip check.

## Time

<!-- Planned: the planning agent's commitment (>= 2m per step). Estimated: written by `at kanban estimate` — do not edit. -->
Planned: 8h

## Files to touch

- `packages/webui/server/routes/api/runs/start.ts` (+ `pause.ts`/`resume.ts` unaffected; verify registry), new `routes/api/runs/[id]/artifacts.ts`, `server/utils/run-dir.ts` (mirror-root aware)
- `packages/cli/src/commands/run.ts` (275 lines, flag parse ~L47) and `resume.ts`: `--remote [url]`, `--token-ref`; extract remote flow to new `packages/cli/src/utils/remote-run.ts` using T203 `remote-client.ts`
- SSE client + reconnect with `Last-Event-ID` (reuse events.ts offsets, see T132 plan `docs/plans/T132-backend-sse-events-offsets.md`)
- Tests: webui `start` with projectId (mirror root, traversal rejected, 409 duplicate); cli `run.remote.test.ts` with an in-process `startBackend` + fixture pipeline using mock tool (no real Chrome); `run.arch.test.ts` / `resume.arch.test.ts` stay green
- Docs: `docs/guiding/architecture.md` (remote lifecycle diagram from idea), `docs/steering/cli.md`, `webui.md`, `docs/guiding/installation.md`, new `docs/guiding/remote-run.md` (user guide + trust warning: uploading a pipeline = remote code execution as serve user, token-protected own machines only, TLS via SSH tunnel); idea doc update
- `docs/SKILL.md`: new flags, remote lifecycle, `.mt/remote` = mandatory update; bump `skill-version` + date; `pnpm --filter=@mt/cli gen:skill`; verify `mt skill`; drift test green

## Steps

- [ ] Read cli.md, webui.md, run.ts, resume.ts, start.ts, runner-registry.ts, T203 plan + code
- [ ] Failing tests: start-by-projectId; artifacts manifest; e2e (in-process server): push -> start -> SSE -> pull -> exit 0; failed remote run -> exit 1; Ctrl+C simulated -> pause call; resume --remote reattaches
- [ ] Server: projectId root resolver + artifacts endpoint
- [ ] CLI: remote-run util + flags in run/resume, DuplexLogger bridge
- [ ] Capability preflight
- [ ] Docs + SKILL.md + gen:skill; gates; `pnpm build:bin && pnpm smoke:bin`; manual smoke with two local ports + token

## Done when

- e2e remote run test green (push, run, stream, pull)
- `mt skill` output matches `docs/SKILL.md`
- lint, typecheck, samples IT, test:gpu, ci:local reported

Gates (report all before FF-merge, per docs/change-workflow.md): `pnpm lint`, `pnpm typecheck`, `pnpm test`, samples IT, `pnpm test:gpu` (unreachable = report failure, never skip), `pnpm ci:local`, `pnpm build:bin && pnpm smoke:bin`. Logging only via logger APIs. No AI attribution trailers.

Deps: blocked by T202, T203. Shares start.ts/run.ts with T205; land T204 first.
