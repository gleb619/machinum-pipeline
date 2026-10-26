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

| ID   | Status  | Title                                                                     | Description                                                                                                                          | Priority | Channel     | Blocks | Blocked By | Plan File                                              |
| :--- | :------ | :------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------- | :------- | :---------- | :----- | :--------- | :----------------------------------------------------- |
| T111 | Backlog | Remove dead Store.appendLines (double-encodes strings)                    | appendLines has no callers and JSON.stringifies string lines; dead-letter.ts doc wrongly cites it as atomic                          | Low      | kanban-loop | -      | -          | docs/plans/T111-store-appendlines-dead-code.md         |
| T123 | Done    | MCP: implement tools/list + pipelines.list/run, runs.list/inspect         | handleToolsList returns \[] and tools/call always errors; steering/UC promise pipelines.\* and runs.\* tools                         | Medium   | kanban-loop | -      | -          | docs/plans/T123-mcp-tool-surface.md                    |
| T133 | Done    | Runner.resume on a done run throws 'done -> done'                         | Resume of finished run emits 'resumed' then crashes on invalid done->done transition; reject up front with clear error               | Medium   | kanban-loop | -      | -          | docs/plans/T133-resume-done-run-guard.md               |
| T135 | Done    | named-entity recognizer tool (opennlp-style) with pluggable backend       | NER tool port of machinum-llm NamedEntityRecognizer: pluggable backends, pure-JS default, bundle-safe                                | Medium   | loop        | -      | -          | plans/T135-named-entity-recognizer-tool-opennlp-sty.md |
| T137 | Backlog | mt tool \<name>: standalone tool invoke is a stub (UC010)                 | tool.ts reads stdin then always exits 1 'not yet implemented'; steering/cli.md and --help advertise it                               | Medium   | kanban-loop | -      | -          | docs/plans/T137-mt-tool-standalone.md                  |
| T140 | Backlog | Glossary review queue + locked/fixedTerms                                 | Pending-change review surface (Target URI or mt command); locked terms always injected, never auto-changed. See docs/ranobe-t...     | Medium   | kanban-loop | -      | -          | plans/T140-glossary-review-queue-locked-fixedterms.md  |
| T141 | Backlog | Per-chapter term/gender timeline for re-translation                       | Terms/genders carry chapter timeline; prompt resolves state at translated chapter; gender flips need verbatim source evidence...     | Medium   | kanban-loop | -      | -          | plans/T141-per-chapter-term-gender-timeline-for-re-.md |
| T142 | Backlog | Source cleaning + validation escape hatch                                 | Credit-line stripping, title dedupe, configurable removals; accept chunk when only untranslated-share fails and is stable acr...     | Low      | kanban-loop | -      | -          | plans/T142-source-cleaning-validation-escape-hatch.md  |
| T143 | Backlog | chapter-doc/indexer: missing or 0 number silently becomes 1               | Number(data.number)\|\|1 turns absent/0 into 1; indexer promises 0, unnumbered chapters overwrite chapter1.md                        | Medium   | kanban-loop | -      | -          | docs/plans/T143-chapter-number-default.md              |
| T144 | Backlog | discoverPipelines: report malformed mt.json, reuse config loader          | discovery.ts swallows bad mt.json (returns \[]) while loadGlobalContext throws; non-array pipelines throws TypeError                 | Low      | kanban-loop | -      | -          | docs/plans/T144-discovery-malformed-config.md          |
| T145 | Backlog | waypoint: resolve jsonl/chapter-output/schema-doc paths vs project.root   | resolveWaypointPath returns cwd-relative paths; only md:// root uses project.root, so runs from another cwd misplace files           | Medium   | kanban-loop | -      | -          | docs/plans/T145-waypoint-paths-project-root.md         |
| T146 | Backlog | Lifecycle hooks phase 2: stop/exit, resume, error events                  | -                                                                                                                                    | Low      | loop        | -      | -          | plans/T146-lifecycle-hooks-phase-2-stop-exit-resume.md |
| T154 | Backlog | token-splitter balanced-line: rebalance() scrambles chunk text            | rebalance moves single chars to the END of another chunk (reversed, mid-word): rebalance(\['abcdefgh','12'])=>\['abcde','12hgf']     | Medium   | kanban-loop | -      | -          | docs/plans/T154-token-splitter-rebalance-order.md      |
| T155 | Backlog | URI parseQueryString: truncates values with '=', throws on bad %          | ?k=a=b keeps only 'a'; a lone '%' makes decodeURIComponent throw an opaque URIError while resolving a source/target                  | Low      | kanban-loop | -      | -          | docs/plans/T155-uri-query-parsing.md                   |
| T156 | Backlog | Replace log-md demo with events\:// scheme + # qualifier shortcut         | log-md:// reads like an md folder; add real events\://\<name>?\<qualifier> target/source scheme and #\<qualifier> shortcut so pip... | Medium   | loop        | -      | -          | docs/plans/events-scheme.md                            |
| T157 | Backlog | Runner logger: unhandled rejection from void logStep                      | logger() fires void logStep(); a failed ensureDir/append rejects unhandled and can crash the process. Catch it.                      | Medium   | loop        | -      | -          | docs/plans/runner-logstep-unhandled-rejection.md       |
| T158 | Backlog | DSL from()/to(): Source/Target instance dropped, re-resolved by URI       | from(instance)/to(instance) keep only .uri; Runner re-resolves via registry, so custom instances are silently ignored/fail.          | Medium   | loop        | -      | -          | docs/plans/dsl-from-to-instance-dropped.md             |
| T159 | Backlog | AtomicStreamWriter.write ignores backpressure (unbounded RAM)             | write() drops stream.write() result; slow disk buffers whole output in memory. Await drain, make write async.                        | Medium   | loop        | -      | -          | docs/plans/atomic-writer-backpressure.md               |
| T161 | Backlog | Backend POST /runs/start: record pipelineFile so mt resume works          | start.ts builds Runner without pipelineFile; state.json lacks it, so mt resume \<id> fails 'older version' for UI-started runs.      | Medium   | loop        | -      | -          | docs/plans/backend-start-record-pipeline-file.md       |
| T162 | Backlog | mt inspect: show dead-letter count and recent entries (UC019)             | dead-letter.jsonl is written but nothing reads it; a done run silently dropped items. Surface count + last entries in inspect.       | Medium   | loop        | -      | -          | docs/plans/inspect-dead-letter.md                      |
| T163 | Backlog | GET /api/runs: reads state.started, field is startedAt                    | runs list returns started: undefined for every run because it reads state.started; RunStateData field is startedAt.                  | Low      | loop        | -      | -          | docs/plans/runs-list-started-field.md                  |
| T164 | Done    | MCP server: answers notifications, no ping, wrong error codes             | No-id notifications get a Method-not-found reply; ping unsupported; bad shape returns -32700 not -32600. Breaks strict clients.      | High     | loop        | -      | -          | docs/plans/mcp-jsonrpc-notifications.md                |
| T165 | Backlog | router getMonthlyCost: local-time month vs UTC log dirs                   | getMonthlyCost builds the month prefix from local time; log dirs are UTC dates, so month-edge hours are dropped/misattributed.       | Low      | loop        | -      | -          | docs/plans/router-monthly-cost-utc.md                  |
| T168 | Backlog | Remove dead mt.json storage.root (never read, .mt hard-coded)             | storage.root is typed+defaulted in config.ts but unread; 21 sites hard-code '.mt'. Setting it silently does nothing. Drop it.        | Low      | loop        | -      | -          | docs/plans/dead-storage-root-config.md                 |
| T171 | Backlog | Chrome ext: default backend URL is router port, perms lock 7777           | Ext posts to localhost:7777 (router) but /api/runs/:id/items lives on mt serve (:3000); host_permissions blocks any other URL.       | Medium   | loop        | -      | -          | docs/plans/chrome-ext-backend-port.md                  |
| T172 | Backlog | VSCode hover: DSL docs wrong (fork/definePipeline), line-wide match       | Hover text documents a non-existent API (fork(name,branches), definePipeline(cfg, fn)), covers 4 of 11 ops, fires on any word...     | Medium   | loop        | -      | -          | docs/plans/vscode-hover-dsl-docs.md                    |
| T173 | Backlog | Test gate integrity: root pnpm test skips sample4, no coverage thresholds | Stray '00260026' token in root test script; sample4 never runs. Add script-parity + coverage gate.                                   | High     | loop        | -      | -          | docs/plans/T173-test-gate-integrity.md                 |
| T174 | Backlog | book-compiler tool: assemble chapters into one book with TOC              | Nothing re-assembles chapter-indexer output; add book compiler tool + book:// target with ordering/completeness report.              | Medium   | loop        | -      | -          | docs/plans/T174-book-compiler-tool.md                  |
| T175 | Backlog | Translation eval harness: golden fixtures + metric thresholds             | No regression signal for LLM prompt/tool changes; fixtures + recorded replies + parity/term/untranslated-share scores gated i...     | Medium   | loop        | -      | -          | docs/plans/T175-translation-eval-harness.md            |
| T176 | Backlog | POST /runs/:id/items SQLite mirror always fails (FK, no runs row)         | run_events.run_id FK->runs(id) with foreign_keys=ON, but nothing inserts runs rows; every mirror INSERT throws and is swallowed.     | Low      | loop        | -      | -          | docs/plans/items-sqlite-fk.md                          |
