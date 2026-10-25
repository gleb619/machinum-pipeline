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

| ID   | Status  | Title                                                                                           | Description                                                                                                                      | Priority | Owner | Blocks | Blocked By | Plan File                                              |
| :--- | :------ | :---------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------- | :------- | :---- | :----- | :--------- | :----------------------------------------------------- |
| T110 | Backlog | DSL batch/window: reject non-positive/NaN size                                                  | batch(0)/window(NaN) silently coerce to 1 in groupStream; fail fast in DSL instead                                               | Medium   | loop  | -      | -          | docs/plans/T110-dsl-batch-window-size-validation.md    |
| T111 | Backlog | Remove dead Store.appendLines (double-encodes strings)                                          | appendLines has no callers and JSON.stringifies string lines; dead-letter.ts doc wrongly cites it as atomic                      | Low      | loop  | -      | -          | docs/plans/T111-store-appendlines-dead-code.md         |
| T112 | Backlog | Backend POST /runs: confine pipeline path to project root                                       | start.ts joins user path unchecked: ../ escapes root and imports arbitrary module; every import error is a 404                   | High     | loop  | -      | -          | docs/plans/T112-backend-start-path-confinement.md      |
| T113 | Backlog | Engine tool cache failures must be best-effort                                                  | cache.set/computeKey errors in runToolItem hit onError: successful tool output is dead-lettered or fails the run                 | Medium   | loop  | -      | -          | docs/plans/T113-engine-cache-best-effort.md            |
| T122 | Backlog | CLI run log is global; mt inspect reads missing per-run run.log                                 | DuplexLogger writes .mt/runs/run.log shared by all runs; inspect reads .mt/runs/\<id>/run.log which never exists                 | Medium   | loop  | -      | -          | docs/plans/T122-cli-per-run-log.md                     |
| T123 | Backlog | MCP: implement tools/list + pipelines.list/run, runs.list/inspect                               | handleToolsList returns \[] and tools/call always errors; steering/UC promise pipelines.\* and runs.\* tools                     | Medium   | loop  | -      | -          | docs/plans/T123-mcp-tool-surface.md                    |
| T125 | Done    | GPU IT: end-to-end through router + vault entry (keyless path)                                  | Extend test:gpu: start router in-process with vault upstream, call ollama/\<model> keyless, assert reply and no key leaks.       | Medium   | loop  | -      | T124       | plans/T125-gpu-it-end-to-end-through-router-vault-e.md |
| T126 | Done    | openrouter-free preset: model is default not pin - tests and docs of precedence                 | After T115 free-model is a default; add precedence tests (settings/meta beat it) and document, sync pool preset.                 | Low      | loop  | -      | -          | plans/T126-openrouter-free-preset-model-is-default-.md |
| T127 | Done    | router dashboard: send MT_ROUTER_TOKEN so UI works behind token auth                            | Dashboard page loads but /api calls 401 when token set; add token prompt/storage and Bearer header in app.js.                    | Medium   | loop  | -      | -          | plans/T127-router-dashboard-send-mt-router-token-so.md |
| T128 | Done    | router: per-client budget (X-MT-Client, MT_CLIENT_BUDGET)                                       | Implement reserved per-client daily budget keyed by X-MT-Client header; 429 with Retry-After; tools send client id.              | Medium   | loop  | -      | -          | plans/T128-router-per-client-budget-x-mt-client-mt-.md |
| T129 | Done    | sample3 cleanup: move reusable defineTool code into packages, drop bespoke tools from pipelines | Sample pipelines must compose existing package tools; reusable logic moves to @mt/tools (or core), rest removed.                 | Medium   | loop  | -      | -          | plans/T129-sample3-cleanup-move-reusable-definetool.md |
| T130 | Done    | router vault-secrets arch test: scan only git-tracked docs, not gitignored plans                | Doc scan reads gitignored docs/plans (local, may name private host) and fails in main; use git ls-files.                         | Low      | loop  | -      | -          | plans/T130-router-vault-secrets-arch-test-scan-only.md |
| T131 | Backlog | chapter-output target: validate meta.lang/chapterNum paths                                      | meta.lang/chapterNum go straight into join(baseDir,..): '../x' escapes target root; md:// already validates                      | Medium   | loop  | -      | -          | docs/plans/T131-chapter-output-path-validation.md      |
| T132 | Backlog | Backend SSE events: byte offsets, partial lines, runId validation                               | events.ts counts UTF-16 chars as byte offsets and drops lines split across chunks; :id joined unvalidated                        | High     | loop  | -      | -          | docs/plans/T132-backend-sse-events-offsets.md          |
| T133 | Backlog | Runner.resume on a done run throws 'done -> done'                                               | Resume of finished run emits 'resumed' then crashes on invalid done->done transition; reject up front with clear error           | Medium   | loop  | -      | -          | docs/plans/T133-resume-done-run-guard.md               |
| T134 | Backlog | bundled md prompts + LLM summary tool adapted from machinum-llm Summary prompts                 | Port SummarySystem/Summary .ST prompts to md files compiled into the package (works from single CLI bundle); summary tool use... | Medium   | loop  | -      | -          | plans/T134-bundled-md-prompts-llm-summary-tool-adap.md |
| T135 | Backlog | named-entity recognizer tool (opennlp-style) with pluggable backend                             | NER tool port of machinum-llm NamedEntityRecognizer: pluggable backends, pure-JS default, bundle-safe                            | Medium   | loop  | -      | -          | plans/T135-named-entity-recognizer-tool-opennlp-sty.md |
| T136 | Backlog | glossary v2: md prompts, relation graph, old-term reuse, NER seeding                            | Refactor glossary tool after machinum-llm Glossary.java: reuse prior terms, relation graph, md prompts, NER candidates           | High     | loop  | -      | -          | plans/T136-glossary-v2-md-prompts-relation-graph-ol.md |
