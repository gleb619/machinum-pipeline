# Kanban: time, plan files, compose

Reference moved out of [kanban.md](kanban.md) (the board stays legend + tasks only).
CLI basics: [cli.md](cli.md#kanban-board-at-kanban).

## Time: planned vs estimated vs consumed

The board has **no** time columns. Time lives in each task's plan file, in a `## Time` section:

```markdown
## Time

Planned: 45m      <- the planning agent's commitment (45m, 2h, 1h30m)
Estimated: 52m    <- written by `at`, never by hand
```

* `Planned` is set by the agent that writes the plan. `Estimated` = `Planned` × a calibration factor —
  the median actual÷planned of Done tasks with recorded runs (clamped 0.25–4; fewer than 3 samples → factor 1).
  `at kanban estimate [id]` recomputes it (no id = every non-Done task); `at compose` does it for each task it claims.
* Consumption is **time only** and not written to the board: compose (`--task` / `--loop`) copies each finished
  run's wall time (retries included) to the durable `<stateDir>/task-metrics.jsonl` (`runs.jsonl` is pruned at
  24h/30 runs), keyed by task id, and tags the run with `taskId`.
* Run Details shows consumed vs planned (+ the estimate); green ≤ plan, yellow ≤ +25%, red above. The Dashboard
  shows total time, over-budget task count and consumed÷planned. WebUI reads `GET /api/usage` (`at bridge usage summary`).
* `at kanban lint` checks every plan file it can find: the `## Time` section must exist (Backlog needs no value yet);
  started tasks (`In Progress` / `Blocked`) need a valid `Planned`; `Estimated`, when set, must be a duration. `Done`
  tasks are exempt (legacy plans). Plan files that are absent/gitignored are skipped, as before.
* Old `Est Time` / `Planned` / `Est Tokens` board columns are harmless leftovers: nothing reads them.

## Plan files: required structure

`at kanban add --plan <path>` creates a missing plan file from a skeleton with every section lint requires:
`## Keywords` (first, so compose's head-of-file scan sees it), `## Goal`, `## Time`, `## Steps`, `## Done when`.
`--keywords a,b` fills Keywords — and when the row has no plan file yet, links a default `plans/<ID>-<slug>.md`
first. On an existing plan without keywords the section is inserted after the title; existing keywords are never rewritten.

```bash
at kanban add --id T61 --title "login flow" --keywords "auth, jwt, src/auth/login.ts"
```

`at kanban lint` checks every plan file it can find (absent/gitignored plans are skipped). `Done` tasks are exempt (legacy).

| Rule | Backlog | In Progress / Blocked |
| ---- | :-----: | :-------------------: |
| `Goal`, `Steps`, `Done when`, `Time` headings exist (any level, case-insensitive, headings in code fences ignored) | ✔ | ✔ |
| Section bodies non-empty; `<placeholder>` lines and `<!-- -->` comments count as empty | – | ✔ |
| `Steps`: every item is `- [ ]` / `- [x]` with real text (`- [ ] 1.` or `- [ ] <...>` fails), ≥ 1 item | – | ✔ |
| `Done when`: ≥ 1 non-placeholder bullet | – | ✔ |
| `Keywords` non-empty (compose seeds INVESTIGATE codegraph context from it) | – | ✔ |
| `Planned` is a valid duration (see Time above) | – | ✔ |
| `Planned` ≥ 2m × number of steps | – | ✔ |

So a fresh skeleton is a valid Backlog plan; the planning agent must fill it in before the task starts.
Code: `src/kanban/plan-lint.ts` (`checkPlanStructure`), wired in `src/kanban/lint.ts` next to `checkPlanTime`.

`at compose` reads the keywords (see [cli.md](cli.md#keywords--investigate-context)) and uses them as
the `at index` / codegraph query in INVESTIGATE, so keep them to concrete symbols, paths and concepts.

## Compose + Kanban

The board is the human-readable durable backlog; `at compose` is the machine that works it. All
compose run detail (state machine, rounds, in-flight runIds) lives outside the board in
`~/.at/compose/<goalId>/` — only the `Status` / `Plan File` cells are ever touched.

```bash
at compose --task T7                 # claim T7 (Backlog -> In Progress) and compose it
at compose --loop                    # claim -> compose -> repeat until nothing is executable
at compose --loop --stop-on-fail     # stop the loop after the first FAILED run
at compose --loop --board <file>     # use a non-default board
at compose --loop --worktree --merge # each task in its own worktree, merged to main when DONE
at compose --loop --follow 60        # board drained? sleep 60s and poll again (until Ctrl-C)
at compose --loop --max-tasks 3      # cap an unattended run
at compose --loop --worktree --merge --follow --background   # detached, survives the terminal
at compose jobs | logs <name> | stop <name>                  # manage background jobs
```

### Follow flow (poll → take → work → repeat)

```
at kanban next [--json]        POLL   first unblocked task: In Progress wins, else Backlog by priority then ID
        │                              (read-only, free; exit 0 + "no executable task" when drained)
        ▼
compose claims (lease + In Progress)   TAKE   pid lease; a live holder's task is skipped, a dead one resumed
        │  --worktree: git worktree add ../<repo>-<id> -b feat/<id> main   (reused on resume)
        ▼
single implementer + --test-cmd gate  WORK   cwd = the task worktree
        │  DONE → Done · FAILED → Blocked (+ outcome.md)
        │  --merge (DONE only): scripts/merge-worktree.sh = rebase + ff-merge + cleanup
        ▼
next claim … drained → exit, or with --follow sleep + poll again
```

* **Poll** = `at kanban next` (same `nextExecutable` rule the loop uses, one selection rule for both).
  `Blocked By` ids must be `Done`; unknown blocker ids are ignored.
* **Worktree** (`--worktree`): path `<repo>-<id-lowercase>` next to the main checkout, branch `feat/<id>`.
  Existing worktree/branch is reused, so a resumed task continues where it stopped. If creation fails the
  task is marked FAILED (→ Blocked) and not run — never silently composed in the shared checkout.
* **Merge** (`--merge`, needs `--worktree`): only after DONE (gate green). Needs the agent to have
  *committed* in the worktree; `DIRTY_WORKTREE` / `REBASE_CONFLICT` / `MERGE_FAIL` / `MAIN_NOT_ON_<base>`
  fail the task run, leave the worktree intact and halt the loop (next task must not build on an
  unmerged base). Without `--merge` the worktree + branch stay for human review.
* **Works in any git repo** (no `scripts/` needed): the project's own `scripts/merge-worktree.sh` is used
  when it exists (it may carry project steps); otherwise the built-in merge does the same sequence —
  clean-tree check, `git rebase <base>` (aborted on conflict), `merge --ff-only` from the main checkout,
  then worktree + branch removal. Nothing is written into the repo. Base branch = `AT_BASE_BRANCH`, else
  origin's HEAD, else `main`/`master`, else the main checkout's current branch. A new worktree also
  symlinks the main checkout's `node_modules` when present (like `scripts/worktree-new.sh`).

### Background jobs

`--background` (with `--task`/`--loop`) re-launches `at compose …` detached and returns at once.

```bash
at compose --loop --worktree --merge --follow 60 --max-tasks 20 --background --name nightly
at compose jobs              # name · running|exited · pid · started · cwd
at compose logs nightly -n 80
at compose stop nightly      # finish the in-flight task, then exit (resumable); --force = SIGKILL
```

* Job records + logs: `<stateDir>/compose-jobs/<name>.{json,log}` — project `.at/` when it exists
  (has `state.json`/`runs.jsonl`), else `~/.at/`; run `jobs`/`logs`/`stop` from the same project.
  Default name = lowercase task id, else `loop`; a live job with the same name is refused.

* The job runs in the cwd it was started from, so board / worktree resolution is the same as foreground.

* A crashed or stopped job is resumed by starting it again — claims resume the leased/in-progress task
  and `state.json` continues the run. It is not a system service: after a reboot start it again
  (or schedule `at compose --loop --background` from cron/systemd).

* **Follow** (`--follow [seconds]`, default 60, needs `--loop`): when nothing is executable the loop
  sleeps and re-polls, so tasks added by humans/`at kanban add` are picked up. First Ctrl-C/SIGTERM ends
  the loop after the in-flight task (resumable via `state.json`); second exits at once.
  Pair with `--max-tasks <n>` as a spend cap. For an external scheduler instead, run
  `at compose --loop` per tick (`/loop 30m …`) — a drained board exits 0 and costs nothing.

* **Default = one implementer run**: the plan file is the spec, so there is no tier-1 PLAN/CHECK — the
  implementer follows it and `--test-cmd` gates DONE. Opt in to the tier-1 pipeline with `--plan-then-do` /
  `AT_PLAN_THEN_DO=1` (see [cli.md](cli.md#compose-single-run-by-default-plan-then-do-opt-in)).

* **Plan-file keywords:** a `## Keywords` section (bullets or comma list; scaffolded by `at kanban add --plan`),
  or `keywords: a, b` (front matter) / a `Keywords: a, b` line (also `labels:` / `tags:`) in the first 30 lines
  of the plan file. INVESTIGATE feeds them to `codegraph context` as the
  query (instead of the whole goal text) to bootstrap `context.md`. The board schema is unchanged.

* Goal text comes from the task's Title + Description (+ `Plan File` content when set).

* goalId is the task id lowercased (`T7` -> `~/.at/compose/t7/`), so re-running is an
  implicit `--resume`: a non-terminal `state.json` continues, a terminal one is skipped.

* Status mapping (configurable via `statusMap` in `createKanbanSource`):

  | Compose event             | Board status                                                                                        |
  | ------------------------- | --------------------------------------------------------------------------------------------------- |
  | claim (`--task`/`--loop`) | `In Progress`                                                                                       |
  | run DONE                  | `Done`                                                                                              |
  | run FAILED                | `Blocked` (+ `outcome.md` in the goal dir; `Plan File` set to the compose plan only when still `-`) |

  The loop then continues with the next executable task (`Blocked By` dependencies gate on `Done`).
  A status missing from the board's legend is warned about and the row is left unchanged.

* **Claim lease:** every claim takes a per-task pid lock (`src/lock.ts`, written to `<boardDir>/locks/`
  under the name of `<boardFile>.claim-<ID>`) and holds it until `onFinish` releases it; a lock whose pid
  died is stale-stolen, so a crashed run frees its own task. `claim()` resumes the first **unleased** task
  already in the claim status (crash or human hand-off) before taking the best unblocked `Backlog` row, and
  skips any row leased by a live pid — two claimers can never be handed the same task.

* **Locking:** every board op (claim, finish) goes through `mutateBoard` (`src/kanban/board.ts`) —
  load → mutate → save inside the `withLock` file mutex, written atomically via
  `src/atomic-write.ts` (temp file + same-dir rename). The lease is taken inside that same mutex, so the
  lease and the `Status` cell land together. Nothing caches board state between ops, so
  **humans may edit the board concurrently**: the next compose op re-loads their changes instead of
  clobbering them.

* Exit code: 0 when no task FAILED, 1 otherwise (also 1 for an unknown `--task <id>`).

* `--prompt`/`--goal` still work as before and need no board. Full flag/state-machine reference:
  [cli.md#compose-plan--implement--check](cli.md#compose-plan--implement--check).
