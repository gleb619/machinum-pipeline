# Kanban Feeder Loop

`/loop 30m docs/kanban-feeder-loop.md`

Prompt for an agent that **feeds** the kanban board `docs/kanban.md`: each tick it investigates the source code and
registers exactly **one** best new idea as a task with a plan file via `at kanban`. It never implements anything —
[kanban-loop.md](kanban-loop.md) consumes the board. Cycle: **check → investigate → pick → register → report → ⏸**.

Feed this file as the prompt on every tick. One tick = at most one new task, then end the turn.
Board and plan format: [kanban.md](kanban.md), [plans/](plans/).

## Required Skills

Invoke before any work:

- `caveman` — compressed communication
- `codegraph` — code exploration; no grep/read loops when `codegraph_*` tools exist

## Rules

- Read-only on code. Board changes only via `at kanban`; plan files only via the plan path `at kanban add` creates.
- Never `git commit/push/stash/reset`. Never edit `~/.at/*`.
- One task per tick. Quality over quantity: no strong idea → register nothing.
- Task IDs: `T` + 3 digits (`T074`). Pass `--id` explicitly (auto-ID emits `T74`, breaks sort).
- Caveman/ultra-brief reports.

## State machine

```
CHECK ─► INVESTIGATE ─► PICK ─► REGISTER ─► REPORT ─► ⏸
  │ invalid board          │ nothing good
  ▼ ⏸ one line             ▼ ⏸ one line
```

### State: CHECK

1. `at kanban lint`. Violations → report verbatim, ⏸ (`FEEDER: BOARD INVALID`).
2. `at kanban list`. Remember all existing titles/keywords (dedupe input). Backlog size is never a stop
   condition: always feed, however full the board is. → **INVESTIGATE**.

### State: INVESTIGATE

Pick **one** focus area, rotating so ticks differ. Choose the area least recently covered by Done/Backlog tasks:

| Area | Where | Look for |
| ---- | ----- | -------- |
| Engine | `packages/core/src/engine/` | dead code, unbounded buffers, ordering bugs, missing checkpoint on a DSL op |
| DSL | `packages/core/src/dsl.ts`, `types.ts` | silent no-ops, `any`, API vs docs mismatch |
| Tools | `packages/tools/src/` | duplicated logic, missing tests, unvalidated I/O |
| Waypoint | `packages/waypoint/src/` | non-atomic writes, URI-scheme gaps |
| CLI/Backend/MCP | `packages/{cli,backend,mcp}/src/` | layer violations, duplicated handlers, error paths |
| Docs vs code | `docs/uc.md`, `docs/steering/*` | promised behavior with no implementation |

Method: `codegraph_context` for the area, then ONE `codegraph_explore` for suspect symbols. Verify a claim by reading the
exact lines before believing it. Also skim `at feedback list` and `git log -20` for recurring pain.

### State: PICK

List up to 3 candidate ideas internally. Score each: **impact** (correctness > simplification > DX), **size**
(prefer ≤ 2h), **risk**, **not already on the board** (match on title and keywords). Keep the single best.
Reject ideas that are style nits, speculative, or need a product decision. None left → ⏸ (`FEEDER: NOTHING NEW`).

### State: REGISTER

1. Next ID: `at kanban list` → highest `T###` + 1, zero-padded to 3 digits.
2. Register:

```bash
at kanban add --id T### --title "<imperative, ≤ 60 chars>" --priority <High|Medium|Low> \
  --plan docs/plans/<kebab-slug>.md --keywords "<files,symbols,concepts>" \
  --description "<≤ 128 chars: what + why>"
```

3. Fill the plan file (template sections `Keywords`, `Goal`, `Time`, `Steps`, `Done when`):
   - **Goal**: the defect or gap with `file:line`, and the intended end state.
   - **Time**: `Planned: <duration>`; each step ≥ 2m. Leave `Estimated: -`.
   - **Steps**: ordered checkboxes, each with a checkable result; start with the failing test.
   - **Done when**: runnable commands (`pnpm --filter=… exec vitest run …`, `pnpm lint && pnpm typecheck`) + expected output.
4. `at kanban lint` must pass; else fix the plan and retry once → **REPORT**.
   Dependencies on other tasks: add `--blocked-by T###` instead of ordering by hand.

### State: REPORT

At most 3 lines: `FEEDER: added T### <title> (<priority>, <Planned>)`, area investigated, backlog size. Then ⏸.

## Safety

- Backlog is unbounded by design; only an invalid board or no good idea skips a tick.
- Read-only: worst case is one bad task row — remove with `at kanban rm T###`.
- Plan files under `docs/plans/` are gitignored in this repo; they live in the main checkout only.
- Regenerate/stop: cancel the `/loop`; no state is kept between ticks except the board itself.
