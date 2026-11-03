# Kanban Board

Lightweight planner for `at` implementation tasks. Machine-mutated by `at kanban` only.

* High-level planner only — details live in [`./docs/plans`](./plans).
* The agent **must** move `Status` when taking a task and again when the work is done.
* Rows stay sorted by `ID`; `at kanban add` enforces this mechanically.

## Mutation rules

* **Board table (the `Task Board` section): machine-mutated only** — never hand-edit rows.
  Every change goes through `at kanban add|status|rm`; `at kanban lint` flags hand edits and
  provenance mismatches.
* **Plan files (`docs/plans/T<id>-*.md`): hand-edited freely** — fill Goal/Steps/Done when,
  keep the `<!-- provenance: row=... -->` last line untouched. If provenance desyncs (lint
  complains "authored against a different board row"), delete the plan file and re-run
  `at kanban add --id T<id> ...` with the same fields to re-stamp it, then restore content.
* **Status transitions:** coding agent owns `In Progress` / `Blocked` / `Done`; planner/user
  owns `Backlog` / `On Hold`. `at compose --loop` moves rows automatically.
* **Channels:** a loop/agent claims tasks only in its own channel (`AT_KANBAN_CHANNEL=x` or
  `at kanban next --channel x`); one implementer per task, sequential per channel.

## Status Legend

| Status        | Meaning                                                  | Who updates it  |
| ------------- | -------------------------------------------------------- | --------------- |
| `On Hold`     | The task is On Hold and not available for execution.     | User            |
| `Backlog`     | Task is defined but not yet started.                     | Planner / agent |
| `In Progress` | An agent is actively working the task.                   | Coding agent    |
| `Blocked`     | Cannot continue until another task or issue is resolved. | Coding agent    |
| `Done`        | Task completed and accepted.                             | Coding agent    |

## Task Board

| ID   | Status  | Title                                                                                 | Description                                                                                                                       | Priority | Channel     | Blocks | Blocked By | Plan File                                              |
| :--- | :------ | :------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------- | :------- | :---------- | :----- | :--------- | :----------------------------------------------------- |
| T144 | Backlog | discoverPipelines: report malformed mt.json, reuse config loader                      | discovery.ts swallows bad mt.json (returns \[]) while loadGlobalContext throws; non-array pipelines throws TypeError              | Low      | kanban-loop | -      | -          | docs/plans/T144-discovery-malformed-config.md          |
| T162 | Backlog | mt inspect: show dead-letter count and recent entries (UC019)                         | dead-letter.jsonl is written but nothing reads it; a done run silently dropped items. Surface count + last entries in inspect.    | Medium   | loop        | -      | -          | docs/plans/inspect-dead-letter.md                      |
| T168 | Backlog | Remove dead mt.json storage.root (never read, .mt hard-coded)                         | storage.root is typed+defaulted in config.ts but unread; 21 sites hard-code '.mt'. Setting it silently does nothing. Drop it.     | Low      | loop        | -      | -          | docs/plans/dead-storage-root-config.md                 |
| T171 | Backlog | Chrome ext: default backend URL is router port, perms lock 7777                       | Ext posts to localhost:7777 (router) but /api/runs/:id/items lives on mt serve (:3000); host_permissions blocks any other URL.    | Medium   | loop        | -      | -          | docs/plans/chrome-ext-backend-port.md                  |
| T172 | Backlog | VSCode hover: DSL docs wrong (fork/definePipeline), line-wide match                   | Hover text documents a non-existent API (fork(name,branches), definePipeline(cfg, fn)), covers 4 of 11 ops, fires on any word...  | Medium   | loop        | -      | -          | docs/plans/vscode-hover-dsl-docs.md                    |
| T174 | Backlog | book-compiler tool: assemble chapters into one book with TOC                          | Nothing re-assembles chapter-indexer output; add book compiler tool + book:// target with ordering/completeness report.           | Medium   | loop        | -      | -          | docs/plans/T174-book-compiler-tool.md                  |
| T175 | Backlog | Translation eval harness: golden fixtures + metric thresholds                         | No regression signal for LLM prompt/tool changes; fixtures + recorded replies + parity/term/untranslated-share scores gated i...  | Medium   | loop        | -      | -          | docs/plans/T175-translation-eval-harness.md            |
| T176 | Backlog | POST /runs/:id/items SQLite mirror always fails (FK, no runs row)                     | run_events.run_id FK->runs(id) with foreign_keys=ON, but nothing inserts runs rows; every mirror INSERT throws and is swallowed.  | Low      | loop        | -      | -          | docs/plans/items-sqlite-fk.md                          |
| T177 | Backlog | mt mcp is a stub that exits 1; wire it to @mt/mcp stdio server                        | docs/steering/mcp.md tells users to run 'mt mcp'; CLI prints 'not yet implemented' and exits 1. Lazy-import startMcpServer.       | Medium   | loop        | -      | -          | docs/plans/cli-mcp-command.md                          |
| T178 | Backlog | mt run --pipeline \<name> breaks scripts.start/end hooks                              | run.ts passes the main --pipeline export name to hook scripts; hook module has no such export, so start hook throws and run a...  | Medium   | loop        | -      | -          | docs/plans/lifecycle-hook-pipeline-name.md             |
| T179 | Backlog | CLI writes (init mt.json/example, pid files) bypass atomicWriteFile                   | init --force overwrites mt.json in place; router/serve pid files written raw. Hard rule: file writes are atomic.                  | Low      | loop        | -      | -          | docs/plans/cli-atomic-writes.md                        |
| T180 | Backlog | SSE /runs/:id/events?stream=true never ends after done/failed                         | Stream mode polls forever; terminal events done/failed are forwarded but the response is never ended, leaking a timer per cli...  | Medium   | loop        | -      | -          | docs/plans/sse-stream-terminate.md                     |
| T181 | Backlog | LLM decorators drop chatCompletionStream: stream:true is a no-op                      | withTimeout/Retry/Cache return {chatCompletion} only, so createLlmClient clients never expose streaming; gate stream:true sil...  | Medium   | loop        | -      | -          | docs/plans/llm-decorators-streaming.md                 |
| T182 | Backlog | router GET /api/logs: unvalidated ?date allows path traversal                         | ?date= goes straight into join(logDir,date,'log.jsonl'); '../..' reads any log.jsonl on disk. Validate YYYY-MM-DD.                | Medium   | loop        | -      | -          | docs/plans/router-logs-date-traversal.md               |
| T183 | Backlog | Remove Exchange.item field: payload lives only in the 'item' variable                 | ex.item is a synced convenience copy of the item variable (~345 call sites). Drop the field; use itemOf/withItem only.            | Medium   | loop        | -      | -          | docs/plans/exchange-item-variable-only.md              |
| T185 | Backlog | Arch test: router/tools OpenRouterPool copies must stay identical                     | Pool class is hand-copied (router must stay standalone); only a comment keeps it in sync. Add a test failing on divergence.       | Low      | loop        | -      | -          | docs/plans/pool-copy-drift-guard.md                    |
| T186 | Done    | Runner: state.json regresses done -> running (stale persist races the terminal write) | MarkRunDone awaits persistState before flushPersists; an older in-flight snapshot can overwrite the terminal done state (~17%...  | High     | loop        | -      | -          | plans/T186-runner-state-json-regresses-done-running.md |
| T187 | Done    | Runner: ctx.run.logger never persists step logs (missing stepId)                      | createRunContext builds logger: this.logger() with no stepId, so tool/source/target log lines reach console but never runs/\<i... | High     | loop        | -      | -          | plans/T187-runner-ctx-run-logger-never-persists-ste.md |
| T188 | Done    | md target file mode silently drops mdOutputs intents                                  | md://.../*.md target appends env.item and ignores mdOutputs intents - silent data loss; throw like series mode already does       | High     | loop        | -      | -          | docs/plans/md-target-file-mode-mdoutputs.md            |
| T189 | Backlog | UC011: tool-to-npx CLI adapter missing (docs vs code)                                 | uc.md UC011 promises tools runnable via npx as stdin/stdout JSON CLI; no adapter helper exists. Add runToolCli to @mt/core        | Medium   | loop        | -      | -          | docs/plans/uc011-tool-npx-adapter.md                   |
| T190 | Backlog | token-splitter: oversized paragraph passes through unsplit                            | Chapter with no blank lines: strategy returns \[text] still over maxTokens; split:false hides it. Add sentence-level fallback ... | Medium   | loop        | -      | -          | docs/plans/token-splitter-oversized-paragraph.md       |
| T191 | Backlog | build:bin fails: compromise\@14.19.0 ships no src/1-one/tag/methods/graph/chapters/   | pnpm build:bin (bun scripts/build-bin.ts) fails with 'Could not resolve: ./chapters/index.js': compromise\@14.19.0's published... | Low      | loop        | -      | -          | plans/T191-build-bin-fails-compromise-14-19-0-ships.md |
| T192 | Backlog | LanguageTool integration: install + check-text tools                                  | Two tools: languagetool-install (compose + readiness) and languagetool-check (chunk, /v2/check, global offsets)                   | Medium   | loop        | -      | -          | docs/plans/T192-languagetool-integration.md            |
