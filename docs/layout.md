# UI layout contract (webui + TUI)

Audience: agents/humans building or changing `packages/components/` (Vue webui) or the terminal UI (`packages/tui/`).
Rule: both UIs are **two skins over one contract**. Same screens, same names, same button positions, same state
colours, same data source (`/api/*` of `mt serve`). A change to one skin updates this file and the other skin in the
same change.

Source of truth today: `packages/components/src/App.vue`. Where this file differs from `App.vue`, `App.vue` is a bug
to fix (or this file is stale — fix one of them).

## 1. Data source

| What | Endpoint | Used by |
|---|---|---|
| Pipelines | `GET /api/pipelines` → `{ path, declared }[]` | Pipelines screen |
| Runs | `GET /api/runs` → `{ id, state, started? }[]` | Runs screen |
| Start | `POST /api/runs/start` `{ pipeline: declared }` → `{ runId }` | `Run` button |
| Pause | `POST /api/runs/:id/pause` | `Pause` button |
| Resume | `POST /api/runs/:id/resume` | `Resume` button |
| Run detail | `GET /api/runs/:id`, `/items`, `/events` (SSE) | Run detail screen (planned) |
| Router cost | `GET /api/dashboard` | Router screen |
| Router pool | `GET /api/pool` | Router screen |
| Router logs | `GET /api/logs?limit=20` | Router screen |

TUI talks to the same HTTP API (via `mt serve`, local or `--detach`) — never imports `@mt/webui` or `@mt/core`
directly (import layers: [steering/structure.md](steering/structure.md)). Pause/resume 404 = "not live in this
process", show it as an error toast, not a crash.

## 2. Screens and names

Fixed names, fixed order. Same labels in both skins.

| # | Name | Content | Status |
|---|---|---|---|
| 1 | **Pipelines** | list of discovered pipelines | done |
| 2 | **Runs** | list of all runs + state | done |
| 3 | **Router** | cost totals, pool status, recent calls (same-origin embedded router) | done |
| 4 | **Run detail** | one run: metadata, steps, live events | planned (UC029) |

Rules:
- Title: `Mt — Pipeline Admin` (web `<title>` + h1; TUI header line).
- Tab order is Pipelines, Runs, Router (then Run detail as a drill-in, not a tab). Default screen on open: **Pipelines**.
- No extra top-level screens without adding a row here first.

## 3. Page skeleton

```
┌──────────────────────────────────────────────────────────────┐
│ Mt — Pipeline Admin         [Pipelines]  [Runs]  [Router]    │  header: title left, tabs right
├──────────────────────────────────────────────────────────────┤
│ ✓ Run started: <runId>                                    ×  │  toast row (only when set)
├──────────────────────────────────────────────────────────────┤
│ <declared>                                         [▶ Run]   │  list rows (body)
│ <path> (dim)                                                 │
│ ...                                                          │
└──────────────────────────────────────────────────────────────┘
  TUI only: footer key-hint bar (§7)
```

Zones, top to bottom, identical in both skins:

1. **Header** — title left, tab switcher right. Active tab = bright/bold; inactive = blue link colour.
2. **Toast** — one row under the header, only when a message exists; dismiss with `×` (web click, TUI `Esc`).
   Success = green; message starting `Error` = red. One toast at a time; a new action clears the old one.
3. **Body** — scrollable list for the active screen.
4. **Footer** (TUI only) — key hints. Web has no footer.

Width: web content column max `max-w-4xl` centered, `px-4 py-8`. TUI uses full terminal width, 1-col padding.

## 4. Rows

Every list row has the same anatomy: **identity block on the left, actions on the right**.

**Pipeline row**
- Left: `declared` (monospace, primary text) over `path` (dim, truncated).
- Right: `▶ Run` button (green).

**Router panel**
- Token field: `Router token` (password input); stored in `sessionStorage` under `mt-router-token`, header-only, never in the URL.
- Cards: `Today`, `Month`, `Daily budget`; each shows USD cost and calls/remaining.
- Pool block: `Pool`, mock badge `MOCK`, active/total keys, rate-limited/blocked counts, upstream names.
- Log block: `Recent calls`; rows show model, optional client, time, tokens and cost.

**Run row**
- Left: `id` (monospace) + `STATE` badge (uppercase, state colour) on one line; `started` (dim) below if present.
- Right (state-dependent, at most one button):
  - `running` → `⏸ Pause` (yellow)
  - `paused` → `▶ Resume` (green)
  - `done` / `failed` / other → no button

Button labels are literal: `▶ Run`, `⏸ Pause`, `▶ Resume`. Keep the glyph + word. Do not rename, reorder or move
them to the left. Buttons stay at the row's right edge.

## 5. State colours

One mapping, both skins (`stateColor()` in `App.vue`).

| State | Web (Tailwind) | TUI (ANSI) |
|---|---|---|
| `running` | `text-green-400` | green |
| `paused` | `text-yellow-400` | yellow |
| `done` | `text-blue-400` | blue |
| `failed` | `text-red-400` | red |
| other (`pending`, …) | `text-gray-500` | dim gray |

Palette (web base): page `bg-gray-900 text-gray-100`; row `border-gray-800 bg-gray-800/50`, hover `border-gray-700`;
dim text `text-gray-600`; link `text-blue-400`. TUI maps to the nearest 16-colour ANSI; no truecolour required.
Dark theme only for now.

Button colours: green = start/resume, yellow = pause. Red is reserved for errors/failed — no destructive button
exists yet; when one is added it is red, last in the row, and confirms first.

## 6. Empty, loading, error

Same text in both skins.

| Case | Text |
|---|---|
| Pipelines loading | `Loading pipelines...` (dim, pulse/spinner) |
| Pipelines error | `<message>` + `Retry` link (red) |
| No pipelines | `No pipelines registered.` |
| No runs | `No runs yet. Start one from the Pipelines tab.` (`Pipelines` is a link/jump) |
| Router loading | `Loading router status...` (dim, pulse/spinner) |
| Router error | `<message>` + `Retry` link (red); 401 => `Router token required or invalid` |
| No router calls | `No router calls logged today.` |
| Action OK | `Run started: <runId>` · `Run <id> paused` · `Run <id> resumed` |
| Action fail | `Error: <message>` |

Runs fetch fails silently (list stays as is) — see T196 for refresh behaviour. Runs list refreshes by polling while
any run is `running`/`paused`; the TUI follows the same cadence (3s active, 30s idle).

## 7. Interaction mapping

Web = mouse first. TUI = keyboard first. Every web action has one fixed key.

| Action | Web | TUI key |
|---|---|---|
| Switch tab | click tab | `1` Pipelines · `2` Runs · `3` Router · `Tab` cycles |
| Move selection | hover | `↑`/`↓` or `k`/`j` |
| Run selected pipeline | `▶ Run` | `r` or `Enter` |
| Pause selected run | `⏸ Pause` | `p` |
| Resume selected run | `▶ Resume` | `p` (toggle: same key, state decides) |
| Retry failed load | `Retry` link | `R` |
| Dismiss toast | `×` | `Esc` |
| Open run detail | click row | `Enter` on a run |
| Back | browser back / tab | `Esc` / `Backspace` |
| Quit | close tab | `q` / `Ctrl+C` |

TUI footer shows the keys valid for the current screen, e.g. `1 Pipelines  2 Runs  3 Router  ↑↓ select  r run  q quit`.
Keys never change meaning between screens: `Esc` always backs out one level.

## 8. Implementation notes

- Webui: Vue 3 SFC + Tailwind 3 (`packages/components/`). Reuse the class strings in §5 verbatim.
- TUI: `@mt/tui` (`packages/tui/`, skeleton — no screens yet). Build the screens with OpenTUI + **SolidJS** (`@opentui/solid`; never React) via the
  OpenTUI skill (`opentui`); the package fetches the API over HTTP only (no `@mt/*` imports).
- Share, don't copy: pure helpers (state → colour name, labels, toast text) should live in one tiny module both
  skins can import once the TUI exists; until then the tables above are the contract.
- Add a test per skin that asserts the labels from §4/§6 (button text, empty/error strings) so drift fails CI.

## 9. Change checklist

1. Change screen/button/label/colour → edit this file first.
2. Update webui **and** TUI (or open a kanban row for the skin not yet built).
3. Update [guiding/uc.md](guiding/uc.md) if a user-visible capability changes.
4. `pnpm lint && pnpm typecheck`.
