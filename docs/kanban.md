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

| ID   | Status  | Title                                                                                                              | Description                                                                                                                       | Priority | Owner | Blocks | Blocked By | Plan File                                              |
| :--- | :------ | :----------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- | :------- | :---- | :----- | :--------- | :----------------------------------------------------- |
| T071 | Done    | Unify fork/subflow via recursive step runner                                                                       | fork/subflow share one recursive buildStream; fork supports all DSL ops; delete ephemeral URI sniffing                            | High     | loop  | -      | -          | docs/plans/recursive-step-runner.md                    |
| T072 | Done    | Fix child-process tools: worker entry + bun runtime                                                                | Add mt-worker entry, runtime→command map, one NDJSON protocol; make exec bun/deno/npx actually work                               | High     | loop  | -      | -          | docs/plans/bun-worker-runtime.md                       |
| T073 | Done    | Ordered bounded mapConcurrent for tool step                                                                        | Extract engine/stream.ts mapConcurrent (ordered, windowed); split runToolItem; drop any casts                                     | Medium   | loop  | -      | -          | docs/plans/map-concurrent.md                           |
| T074 | Done    | Atomic writes in waypoint targets (hard rule)                                                                      | Waypoint targets use raw writeFile/append streams, violating atomic-write rule; add shared atomicWrite, tmp+rename on close       | High     | loop  | -      | -          | docs/plans/waypoint-atomic-writes.md                   |
| T075 | Done    | fail-run onError swallowed: runs exit 0 despite tool ERRORs                                                        | runner.ts Promise.any(p.catch) eats fail-run throw; failed items dropped silently, run marked done, exit 0                        | High     | loop  | -      | -          | docs/plans/fail-run-swallowed.md                       |
| T076 | Done    | schema-doc Summary parse fails on chapters with H1 in body                                                         | normalizeToSchemaDoc puts whole body incl. inner '# ' heading into ## Summary; mdshape paragraph() rejects; schemaDocPipeline...  | High     | loop  | -      | -          | docs/plans/schema-doc-summary-parse.md                 |
| T077 | Done    | Empty source feeds fake {item:{}} envelope; validator TypeError                                                    | runner createEmptyStream injects empty object when source yields nothing; chapterValidator text.split crashes; smoke subflow ...  | Medium   | loop  | -      | -          | docs/plans/empty-source-envelope.md                    |
| T078 | Done    | sample2 drift: collectWarnings tap wrong meta key, README misses countTokensFlow                                   | collectWarnings tap logs meta.errors but forbiddenCharDetector writes meta.forbidden; README says 9 subflows, actual 10           | Low      | loop  | -      | -          | docs/plans/sample2-docs-drift.md                       |
| T079 | Done    | Refactor schema-doc tools (summary/entities/schema/vocabulary/metadata) to LLM via runPrompt with retry loop guard | Extract 5 extraction tools to own files; call runPrompt/chatCompletionSingle w/ configurable prompts; 2-3x retry loop guard w\... | High     | loop  | -      | -          | docs/plans/schema-tools-llm-runprompt.md               |
| T080 | Done    | Fix root pnpm typecheck failure in @mt/backend                                                                     | -                                                                                                                                 | Low      | loop  | -      | -          | plans/T080-fix-root-pnpm-typecheck-failure-in-mt-ba.md |
| T081 | Done    | Remove Tool.exec/module out-of-proc setting (inproc only)                                                          | -                                                                                                                                 | Low      | loop  | -      | -          | docs/plans/remove-tool-exec-out-of-proc.md             |
| T082 | Backlog | Bun single-file binary + publishable 'mt' package (import from 'mt')                                               | packages/mt umbrella (core+tools+waypoint+cli) and bun --compile self-contained mt binary                                         | Medium   | loop  | -      | -          | docs/plans/bun-binary-and-mt-package.md                |
