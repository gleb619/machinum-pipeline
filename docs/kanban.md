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

| ID   | Status      | Title                                                                                         | Description                                                                                                                   | Priority | Owner | Blocks | Blocked By | Plan File                                           |
| :--- | :---------- | :-------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------- | :------- | :---- | :----- | :--------- | :-------------------------------------------------- |
| T084 | Done        | Fix pause/resume 404: start.ts never calls registerRunner                                     | Admin API pause/resume return 404 because runs started via POST /api/runs never register their Runner                         | High     | loop  | -      | -          | docs/plans/T084-fix-pause-resume-register-runner.md |
| T085 | In Progress | Harden Bun binary: lockfile, cross-target runtime, native addons, import fallback, layer rule | Close T082/T083 gaps: validate lockfile, run foreign targets, test native addons, per-import zod fallback, cli->backend rule  | Medium   | loop  | T086   | -          | docs/plans/T085-harden-bun-binary.md                |
| T086 | Backlog     | mt router inside single Bun binary (mt router subcommand)                                     | Embed @mt/router OpenRouter proxy + dashboard in mt binary/npm pkg; replace 'mt router not implemented' stub                  | Medium   | loop  | -      | T085       | docs/plans/T086-mt-router-in-binary.md              |
| T087 | Done        | Tools emit md output intents; waypoint resolves paths                                         | mdOutputEmitter subdir instead of hardcoded dir; md:// target resolves root from URI/defaultFolder/project.root and validates | High     | loop  | -      | -          | docs/plans/md-output-intent.md                      |
| T088 | Backlog     | git-worktree Source/Target: process.chdir leaks across yields                                 | yield* inside chdir leaves cwd=worktree for downstream steps; concurrent writes race. Use explicit cwd, not chdir.            | Medium   | loop  | -      | -          | docs/plans/T088-git-worktree-chdir-leak.md          |
| T089 | Backlog     | Engine never writes events.jsonl; /api/runs/:id/events always 404                             | Backend tails .mt/runs/\<id>/events.jsonl but runner never appends it; SSE 404s on real runs. Emit step events.               | High     | loop  | -      | -          | docs/plans/T089-runner-write-events-jsonl.md        |
