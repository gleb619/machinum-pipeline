# Kanban Board

Lightweight planner for `at` implementation tasks. Machine-mutated by `at kanban` only.

* High-level planner only — details live in [`./docs/plans`](./plans).
* The agent **must** move `Status` when taking a task and again when the work is done.
* Rows stay sorted by `ID`; `at kanban add` enforces this mechanically.

## Status Legend

| Status        | Meaning                                                  | Who updates it  |
| ------------- | -------------------------------------------------------- | --------------- |
| `On Hold`     | The task is On Hold and not available for execution.     | User            |
| `Backlog`     | Task is defined but not yet started.                     | Planner / agent |
| `In Progress` | An agent is actively working the task.                   | Coding agent    |
| `Blocked`     | Cannot continue until another task or issue is resolved. | Coding agent    |
| `Done`        | Task completed and accepted.                             | Coding agent    |

## Task Board

| ID   | Status      | Title                                                                                         | Description                                                                                                                    | Priority | Owner | Blocks | Blocked By | Plan File                                           |
| :--- | :---------- | :-------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- | :------- | :---- | :----- | :--------- | :-------------------------------------------------- |
| T084 | Done        | Fix pause/resume 404: start.ts never calls registerRunner                                     | Admin API pause/resume return 404 because runs started via POST /api/runs never register their Runner                          | High     | loop  | -      | -          | docs/plans/T084-fix-pause-resume-register-runner.md |
| T085 | Done        | Harden Bun binary: lockfile, cross-target runtime, native addons, import fallback, layer rule | Close T082/T083 gaps: validate lockfile, run foreign targets, test native addons, per-import zod fallback, cli->backend rule   | Medium   | loop  | T086   | -          | docs/plans/T085-harden-bun-binary.md                |
| T086 | Done        | mt router inside single Bun binary (mt router subcommand)                                     | Embed @mt/router OpenRouter proxy + dashboard in mt binary/npm pkg; replace 'mt router not implemented' stub                   | Medium   | loop  | -      | T085       | docs/plans/T086-mt-router-in-binary.md              |
| T087 | Done        | Tools emit md output intents; waypoint resolves paths                                         | mdOutputEmitter subdir instead of hardcoded dir; md:// target resolves root from URI/defaultFolder/project.root and validates  | High     | loop  | -      | -          | docs/plans/md-output-intent.md                      |
| T088 | Blocked     | git-worktree Source/Target: process.chdir leaks across yields                                 | yield* inside chdir leaves cwd=worktree for downstream steps; concurrent writes race. Use explicit cwd, not chdir.             | Medium   | loop  | -      | -          | docs/plans/T088-git-worktree-chdir-leak.md          |
| T089 | Done        | Engine never writes events.jsonl; /api/runs/:id/events always 404                             | Backend tails .mt/runs/\<id>/events.jsonl but runner never appends it; SSE 404s on real runs. Emit step events.                | High     | loop  | -      | -          | docs/plans/T089-runner-write-events-jsonl.md        |
| T090 | Done        | Runner.resume replays source from start; Source.resume never called                           | resume() uses first non-done node only as bool, restarts source.start(); no cursor saved. Resume = cache replay.               | High     | loop  | -      | -          | docs/plans/T090-runner-resume-source-cursor.md      |
| T091 | Done        | router breaks 'standalone' rule: imports @mt/tools, unused @mt/core dep                       | router docs say no @mt/* deps; code imports OpenRouterPool from @mt/tools, lists @mt/core. Decouple + arch test.               | Medium   | loop  | -      | -          | docs/plans/T091-router-standalone-layer.md          |
| T092 | Done        | One loadGlobalContext: CLI/backend diverge, secrets.envFile unread                            | 3 hand-rolled GlobalContext builders; backend ignores mt.json, CLI env={}, envFile never loaded. Share one core loader.        | High     | loop  | -      | -          | docs/plans/T092-unified-global-context.md           |
| T093 | In Progress | Engine withRetry retries non-retryable errors (402/401/ctx-len)                               | withRetry retries every throw; LlmError.retryable=false still burns 3 backoffs. Honor retryable flag + Retry-After, cap delay. | Medium   | loop  | -      | -          | docs/plans/T093-engine-retry-honor-retryable.md     |
| T094 | Backlog     | http source: /events steals buffered items, close() hangs                                     | SSE client drains pipeline buffer (items lost), gets no live data; server.close waits on open SSE; no body cap.                | Medium   | loop  | -      | -          | docs/plans/T094-http-source-events-shutdown.md      |
| T095 | Done        | Partial .use() retry override never merged: {backoffMs} skips tool                            | DSL allows partial retry; runner casts to full RetryPolicy. Missing max => loop never runs, tool skipped, throws undefined.    | High     | loop  | -      | -          | docs/plans/T095-merge-partial-retry-override.md     |
| T096 | Backlog     | mt resume \<runId> needs pipeline file; wrong file silently accepted                          | Docs: 'mt resume \<runId>'. Code needs \<pipeline.ts>, state.json lacks path, pipelineId never checked vs loaded file.         | Medium   | loop  | -      | -          | docs/plans/T096-resume-pipeline-ref.md              |
| T097 | Backlog     | jsonl source: no envelope validation, resume cursor/batch drift                               | Lines cast to Envelope unchecked; parse errors lack file:line; non-glob resume ignores batchSize, counts blank lines.          | Medium   | loop  | -      | -          | docs/plans/T097-jsonl-source-validation-resume.md   |
