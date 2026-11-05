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

| ID   | Status      | Title                                                                                    | Description                                                                                                                       | Priority | Channel | Blocks | Blocked By | Plan File                                              |
| :--- | :---------- | :--------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- | :------- | :------ | :----- | :--------- | :----------------------------------------------------- |
| T168 | Backlog     | Remove dead mt.json storage.root (never read, .mt hard-coded)                            | storage.root is typed+defaulted in config.ts but unread; 21 sites hard-code '.mt'. Setting it silently does nothing. Drop it.     | Low      | loop    | -      | -          | docs/plans/dead-storage-root-config.md                 |
| T176 | Backlog     | POST /runs/:id/items SQLite mirror always fails (FK, no runs row)                        | run_events.run_id FK->runs(id) with foreign_keys=ON, but nothing inserts runs rows; every mirror INSERT throws and is swallowed.  | Low      | loop    | -      | -          | docs/plans/items-sqlite-fk.md                          |
| T179 | Backlog     | CLI writes (init mt.json/example, pid files) bypass atomicWriteFile                      | init --force overwrites mt.json in place; router/serve pid files written raw. Hard rule: file writes are atomic.                  | Low      | loop    | -      | -          | docs/plans/cli-atomic-writes.md                        |
| T180 | Backlog     | SSE /runs/:id/events?stream=true never ends after done/failed                            | Stream mode polls forever; terminal events done/failed are forwarded but the response is never ended, leaking a timer per cli...  | Medium   | loop    | -      | -          | docs/plans/sse-stream-terminate.md                     |
| T181 | Backlog     | LLM decorators drop chatCompletionStream: stream:true is a no-op                         | withTimeout/Retry/Cache return {chatCompletion} only, so createLlmClient clients never expose streaming; gate stream:true sil...  | Medium   | loop    | -      | -          | docs/plans/llm-decorators-streaming.md                 |
| T182 | Backlog     | router GET /api/logs: unvalidated ?date allows path traversal                            | ?date= goes straight into join(logDir,date,'log.jsonl'); '../..' reads any log.jsonl on disk. Validate YYYY-MM-DD.                | Medium   | loop    | -      | -          | docs/plans/router-logs-date-traversal.md               |
| T183 | Backlog     | Remove Exchange.item field: payload lives only in the 'item' variable                    | ex.item is a synced convenience copy of the item variable (~345 call sites). Drop the field; use itemOf/withItem only.            | Medium   | loop    | -      | -          | docs/plans/exchange-item-variable-only.md              |
| T185 | Backlog     | Arch test: router/tools OpenRouterPool copies must stay identical                        | Pool class is hand-copied (router must stay standalone); only a comment keeps it in sync. Add a test failing on divergence.       | Low      | loop    | -      | -          | docs/plans/pool-copy-drift-guard.md                    |
| T189 | Backlog     | UC011: tool-to-npx CLI adapter missing (docs vs code)                                    | uc.md UC011 promises tools runnable via npx as stdin/stdout JSON CLI; no adapter helper exists. Add runToolCli to \@mt/core       | Medium   | loop    | -      | -          | docs/plans/uc011-tool-npx-adapter.md                   |
| T190 | Backlog     | token-splitter: oversized paragraph passes through unsplit                               | Chapter with no blank lines: strategy returns \[text] still over maxTokens; split:false hides it. Add sentence-level fallback ... | Medium   | loop    | -      | -          | docs/plans/token-splitter-oversized-paragraph.md       |
| T191 | Backlog     | build:bin fails: compromise\@14.19.0 ships no src/1-one/tag/methods/graph/chapters/      | pnpm build:bin (bun scripts/build-bin.ts) fails with 'Could not resolve: ./chapters/index.js': compromise\@14.19.0's published... | Low      | loop    | -      | -          | plans/T191-build-bin-fails-compromise-14-19-0-ships.md |
| T192 | Backlog     | LanguageTool integration: install + check-text tools                                     | Two tools: languagetool-install (compose + readiness) and languagetool-check (chunk, /v2/check, global offsets)                   | Medium   | loop    | -      | -          | docs/plans/T192-languagetool-integration.md            |
| T195 | Backlog     | router cost log: 5MB rotation runs only at boot (UC036)                                  | rotateLogs fires once at boot; a long-lived router never rotates or prunes after that. UC036 promises size-check on write. Ad...  | Medium   | loop    | -      | -          | docs/plans/router-log-rotation-boot-only.md            |
| T196 | Backlog     | UI runs list is stale: no refresh while run states change                                | App.vue fetches /api/runs once on mount and after user actions only; running/paused states never update. Poll while runs active   | Medium   | loop    | -      | -          | docs/plans/frontend-runs-stale.md                      |
| T198 | Backlog     | chrome typeContent: contenteditable editors silently unsupported                         | typeContent sets .value on input/textarea only; contenteditable web editors (the UC043 use case) get nothing. Support isConte...  | Medium   | loop    | -      | -          | docs/plans/chrome-typecontent-contenteditable.md       |
| T199 | Backlog     | Remove 34 tracked compiled test artifacts under packages/core/tests                      | tsc output (.js/.d.ts/.map) committed in packages/core/tests, drifting from .ts sources; delete from git, ignore, verify vite...  | Low      | loop    | -      | -          | docs/plans/core-tests-compiled-artifacts.md            |
| T207 | Backlog     | md:// target: validate meta.chapterNum before writing chapter files                      | md:// dir mode writes chapterN.md from unvalidated meta.chapterNum: traversal escapes root, 0 swallowed, dup numbers overwrite    | High     | loop    | -      | -          | docs/plans/md-target-chapter-num-validation.md         |
| T208 | Backlog     | Emit engine log lines in the requested --json format                                     | Runner hardcodes formatLogLine, so \`mt run --json\` mixes JSONL (CLI lines) with text (engine/tool lines); not parseable JSONL   | Medium   | loop    | -      | -          | docs/plans/json-log-format-engine-propagation.md       |
| T209 | In Progress | Domain tree: fluent navigation/mutation methods on chapter/chunk/paragraph/line          | Chapters/chunks/paragraphs expose fluent navigation + mutation (chapter.chunks()\[0].paragraphs()\[0].lines\[0]); update sample2  | Medium   | loop    | -      | -          | docs/plans/T209-domain-tree-navigation-methods.md      |
| T210 | Done        | Chapter metadata: fluent frontmatter access/mutation in ChapterDoc + intermediate sample | ChapterDoc frontmatter exposes chapter.metadata().number/.add(key,val); unknown keys round-trip; update sample2 intermediate      | Medium   | loop    | -      | -          | docs/plans/T210-chapter-metadata-api.md                |
| T211 | Backlog     | Make MCP resources/read return real pipeline content                                     | resources/read on mt://pipeline/ echoes {path} instead of the file; resources/list omits runs the doc promises                    | Medium   | loop    | -      | -          | docs/plans/mcp-resources-read-pipeline-content.md      |
| T212 | Backlog     | Make schema-doc:// source read a directory of chapter docs                               | schema-doc:// source readFile()s the URI path, so the documented dir form schema-doc://./docs/ throws EISDIR                      | Medium   | loop    | -      | -          | docs/plans/schema-doc-source-directory-read.md         |
| T213 | Backlog     | sample2 intermediate: share one pipeline run, raise exec timeout                         | Each it() re-runs mt with 10s timeout; full sample2 suite under load hits ETIMEDOUT. Run once in beforeAll; bump timeout.         | Medium   | loop    | -      | -          | docs/plans/T213-sample2-intermediate-test-flake.md     |
