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

| ID   | Status  | Title                                               | Description                                                                                                                 | Priority | Owner | Blocks | Blocked By | Plan File                            |
| :--- | :------ | :-------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- | :------- | :---- | :----- | :--------- | :----------------------------------- |
| T071 | Blocked | Unify fork/subflow via recursive step runner        | fork/subflow share one recursive buildStream; fork supports all DSL ops; delete ephemeral URI sniffing                      | High     | loop  | -      | -          | docs/plans/recursive-step-runner.md  |
| T072 | Backlog | Fix child-process tools: worker entry + bun runtime | Add mt-worker entry, runtime→command map, one NDJSON protocol; make exec bun/deno/npx actually work                         | High     | loop  | -      | -          | docs/plans/bun-worker-runtime.md     |
| T073 | Backlog | Ordered bounded mapConcurrent for tool step         | Extract engine/stream.ts mapConcurrent (ordered, windowed); split runToolItem; drop any casts                               | Medium   | loop  | -      | -          | docs/plans/map-concurrent.md         |
| T074 | Backlog | Atomic writes in waypoint targets (hard rule)       | Waypoint targets use raw writeFile/append streams, violating atomic-write rule; add shared atomicWrite, tmp+rename on close | High     | loop  | -      | -          | docs/plans/waypoint-atomic-writes.md |
