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

| ID   | Status      | Title                                                                                           | Description                                                                                                                | Priority | Owner | Blocks | Blocked By | Plan File                                              |
| :--- | :---------- | :---------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- | :------- | :---- | :----- | :--------- | :----------------------------------------------------- |
| T110 | Backlog     | DSL batch/window: reject non-positive/NaN size                                                  | batch(0)/window(NaN) silently coerce to 1 in groupStream; fail fast in DSL instead                                         | Medium   | loop  | -      | -          | docs/plans/T110-dsl-batch-window-size-validation.md    |
| T111 | Backlog     | Remove dead Store.appendLines (double-encodes strings)                                          | appendLines has no callers and JSON.stringifies string lines; dead-letter.ts doc wrongly cites it as atomic                | Low      | loop  | -      | -          | docs/plans/T111-store-appendlines-dead-code.md         |
| T112 | Backlog     | Backend POST /runs: confine pipeline path to project root                                       | start.ts joins user path unchecked: ../ escapes root and imports arbitrary module; every import error is a 404             | High     | loop  | -      | -          | docs/plans/T112-backend-start-path-confinement.md      |
| T113 | Backlog     | Engine tool cache failures must be best-effort                                                  | cache.set/computeKey errors in runToolItem hit onError: successful tool output is dead-lettered or fails the run           | Medium   | loop  | -      | -          | docs/plans/T113-engine-cache-best-effort.md            |
| T122 | Backlog     | CLI run log is global; mt inspect reads missing per-run run.log                                 | DuplexLogger writes .mt/runs/run.log shared by all runs; inspect reads .mt/runs/\<id>/run.log which never exists           | Medium   | loop  | -      | -          | docs/plans/T122-cli-per-run-log.md                     |
| T123 | Backlog     | MCP: implement tools/list + pipelines.list/run, runs.list/inspect                               | handleToolsList returns \[] and tools/call always errors; steering/UC promise pipelines.\* and runs.\* tools               | Medium   | loop  | -      | -          | docs/plans/T123-mcp-tool-surface.md                    |
| T125 | Backlog     | GPU IT: end-to-end through router + vault entry (keyless path)                                  | Extend test:gpu: start router in-process with vault upstream, call ollama/\<model> keyless, assert reply and no key leaks. | Medium   | loop  | -      | T124       | plans/T125-gpu-it-end-to-end-through-router-vault-e.md |
| T126 | In Progress | openrouter-free preset: model is default not pin - tests and docs of precedence                 | After T115 free-model is a default; add precedence tests (settings/meta beat it) and document, sync pool preset.           | Low      | loop  | -      | -          | plans/T126-openrouter-free-preset-model-is-default-.md |
| T127 | Backlog     | router dashboard: send MT_ROUTER_TOKEN so UI works behind token auth                            | Dashboard page loads but /api calls 401 when token set; add token prompt/storage and Bearer header in app.js.              | Medium   | loop  | -      | -          | plans/T127-router-dashboard-send-mt-router-token-so.md |
| T128 | Done        | router: per-client budget (X-MT-Client, MT_CLIENT_BUDGET)                                       | Implement reserved per-client daily budget keyed by X-MT-Client header; 429 with Retry-After; tools send client id.        | Medium   | loop  | -      | -          | plans/T128-router-per-client-budget-x-mt-client-mt-.md |
| T129 | In Progress | sample3 cleanup: move reusable defineTool code into packages, drop bespoke tools from pipelines | Sample pipelines must compose existing package tools; reusable logic moves to @mt/tools (or core), rest removed.           | Medium   | loop  | -      | -          | plans/T129-sample3-cleanup-move-reusable-definetool.md |
