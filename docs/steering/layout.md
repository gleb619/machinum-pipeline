# UI layout contract (webui + TUI)

Audience: agents/humans building or changing `packages/components/` (Vue webui) or the terminal UI (`packages/tui/`).
Rule: both UIs are **two skins over one contract**. Same screens, same names, same button positions, same state
colours, same data source (`/api/*` of `mt serve`). A change to one skin updates this file and the other skin in the
same change.

One component library, two hosts: the same Vue components run in the web admin (`packages/webui` serves the
`packages/components` build) and inside the VS Code extension (`packages/vscode`, webview) so pipeline `.ts` files
can be worked on locally in VS Code too. See §11.

Source of truth today: `packages/components/src/App.vue`. §10 describes the target **Studio** shell (IDE-style
layout); until it lands, §1–§9 describe the shipped tabbed shell. Where this file differs from `App.vue`, `App.vue` is a bug
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
| Workers | `GET /api/workers` → `{ id, name, tags, status, lastSeen, runs }[]` | Workers screen (planned) |
| Router cost | `GET /api/dashboard` | Router screen |
| Router pool | `GET /api/pool` | Router screen |
| Router logs | `GET /api/logs?limit=20` | Router screen |

TUI talks to the same HTTP API (via `mt serve`, local or `--detach`) — never imports `@mt/webui` or `@mt/core`
directly (import layers: [steering/structure.md](structure.md)). Pause/resume 404 = "not live in this
process", show it as an error toast, not a crash.

## 2. Screens and names

Fixed names, fixed order. Same labels in both skins.

| # | Name | Content | Status |
|---|---|---|---|
| 1 | **Pipelines** | list of discovered pipelines | done |
| 2 | **Runs** | list of all runs + state | done |
| 3 | **Router** | cost totals, pool status, recent calls (same-origin embedded router) | done |
| 4 | **Run detail** | one run: metadata, steps, live events | planned (UC029) |
| 5 | **Workers** | registered `mt worker` peers: name, tags, online/lost, mirrored runs | planned (T205 API only) |

Rules:

- Title: `Mt — Pipeline Admin` (web `<title>` + h1; TUI header line).
- Sidebar order (and the order of tabs in a fresh workspace) is Pipelines, Runs, Router, Workers. Default screen on
  open: **Pipelines**. These four are singleton *view tabs*; Run detail opens as a document tab, not a fifth sidebar
  entry. Open order, not this list, orders the live tab strip — see §10.9.
- No extra top-level screens without adding a row here first.

## 3. Page skeleton

```text
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

### Pipeline row

- Left: `declared` (monospace, primary text) over `path` (dim, truncated).
- Right: `▶ Run` button (green).

### Router panel

- Token field: `Router token` (password input); stored in `sessionStorage` under `mt-router-token`, header-only, never in the URL.
- Cards: `Today`, `Month`, `Daily budget`; each shows USD cost and calls/remaining.
- Pool block: `Pool`, mock badge `MOCK`, active/total keys, rate-limited/blocked counts, upstream names.
- Log block: `Recent calls`; rows show model, optional client, time, tokens and cost.

### Run row

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
| Open/focus screen tab | click tab / rail icon | `1` Pipelines · `2` Runs · `3` Router · `4` Workers |
| Cycle open tabs | `Ctrl+Tab` / `Ctrl+Shift+Tab` | `Tab` / `Shift+Tab` |
| Close tab | `×` / middle-click / `Ctrl+W` | `x` / `Ctrl+W` |
| Quick open | `Ctrl+K P` | `Ctrl+P` |
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

1. Change screen/button/label/colour/navigation → edit this file first (§10.9 for tabs/accordion/sidebar).
2. Update webui **and** TUI (or open a kanban row for the skin not yet built).
3. Update [guiding/uc.md](../guiding/uc.md) if a user-visible capability changes.
4. `pnpm lint && pnpm typecheck`.

## 10. Studio shell (target layout, planned)

Conceptually VS Code: code on the left, graph on the right, collapsible activity sidebar, toolbar on top, status bar
at the bottom. Web only first; the TUI keeps §3 (no editor/graph). §1–§9 stay valid: screens, labels, colours and
states are reused inside the new shell.

### 10.1 Skeleton

This is the **web** host. In VS Code the editor pane is the native editor and the sidebar/toolbar/status bar are native
VS Code UI; the graph pane is the shared component ([§11](#11-hosts-web-and-vs-code-shared-components)).

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Mt  ▸ pipeline.ts      [▶ Run] [⏸ Pause] [■ Stop]  [Auto-layout] [Save]    │ toolbar
├──┬─────────────────────────────┬─┬───────────────────────────────────────┤
│☰ │ editor tab: pipeline.ts     │ │ ┌─ Source ─▶ Tool ─▶ Target ─┐        │
│📁│ ┌─────────────────────────┐ │▮│ │  (Vue Flow, read-only v1)   │ [mini] │
│▶ │ │ definePipeline()        │ │ │ └────────────────────────────┘        │
│⚙ │ │  .from('md://…')        │ │ │                                       │
│  │ │  .use(translate)        │ │ │                                       │
│  │ └─────────────────────────┘ │ │                                       │
├──┴─────────────────────────────┴─┴───────────────────────────────────────┤
│ ● running  run 8f3a…  step 3/7  items 120   router $0.42        UTF-8  Ln 4 │ status bar
└────────────────────────────────────────────────────────────────────────────┘
 rail(48px)  editor pane (Monaco)   splitter  graph pane (Vue Flow)
```

Zones (names fixed, same wording in code and docs):

| Zone | Name | Content |
|---|---|---|
| top | **Toolbar** | title/breadcrumb left, run controls centre, graph/editor actions right |
| left | **Sidebar** | activity rail + collapsible panel (§10.2) |
| centre-left | **Editor pane** | Monaco, pipeline module source |
| centre-right | **Graph pane** | Vue Flow view of the pipeline steps |
| middle | **Splitter** | draggable divider between editor and graph |
| bottom | **Status bar** | run state, step, counts, router cost, cursor position |

The §3 toast row sits just under the toolbar. Header tabs from §2 become **workspace tabs** (§10.9): each screen is one
singleton view tab and the sidebar rail is a shortcut that opens-or-focuses it. The sidebar panel lists documents
(pipelines, runs); clicking a row opens a document tab. Run detail is a document tab too. Default view on open:
Pipelines tab active, sidebar expanded, first pipeline loaded.

### 10.2 Sidebar

- Two states: **rail** (48 px, icons only, vertical line) and **expanded** (240 px, rail + panel with labels).
- Rail icons, fixed order top to bottom: Pipelines, Runs, Router, Workers; Settings pinned at the bottom.
- Rail click = `openTab({ id: 'view:<screen>' })` (§10.9): first click opens the tab, every later click only focuses
  it. The rail is navigation chrome, never a tab itself — every screen must also be reachable without the sidebar
  (TUI has none, deep links exist).
- Click the active icon or press `Ctrl+B` to toggle the panel; click another icon while collapsed = expand to that panel.
- Active icon = bright with a left accent bar; hover shows a tooltip with the screen name from §2.
- Width animates (`transition-[width] duration-200`); state persisted in `localStorage` key `mt-sidebar`
  (`{ collapsed, panel }`), wrapped in try/catch. Below 768 px the sidebar is an overlay drawer, collapsed by default.
- a11y: toggle is a `<button aria-expanded aria-controls>`, rail is `role="tablist"` (`aria-orientation="vertical"`),
  icon buttons carry `aria-label` = screen name.

### 10.3 Toolbar

| Button | Label | Colour | Action |
|---|---|---|---|
| Run | `▶ Run` | green | `POST /api/runs/start` for the open pipeline |
| Pause / Resume | `⏸ Pause` / `▶ Resume` | yellow / green | same endpoints as §1; state decides |
| Stop | `■ Stop` | red, confirms first | planned: needs `POST /api/runs/:id/stop` (no API yet) |
| Auto-layout | `Auto-layout` | neutral | re-run dagre on the graph |
| Save | `Save` | neutral | write editor text back to the pipeline file (needs write API) |

Labels are literal, same rule as §4. Buttons disabled (not hidden) when the state does not allow them. Keys:
`Ctrl+Enter` run, `Ctrl+S` save, `Ctrl+B` sidebar, `Ctrl+J` focus graph, `Ctrl+K Z` swap panes (optional).

### 10.4 Editor pane

- `monaco-editor` loaded lazily (`defineAsyncComponent` + dynamic `import()`); never in the initial chunk.
- Workers bundled in Vite via `vite-plugin-monaco-editor-esm` (only `editorWorkerService` + `typescript`); a missing
  worker is a build-time/CI failure, not a runtime surprise.
- Theme `vs-dark`, language `typescript`; type definitions of `@mt/core` DSL fed as extra lib so `definePipeline()`
  completes. Read from `GET /api/pipelines/:declared/source` (planned); v1 may be read-only.
- Editor owns the source of truth; graph never writes back in v1.

### 10.5 Graph pane (Vue Flow)

Library: `@vue-flow/core` + `@vue-flow/background`, `minimap`, `controls`. Import `@vue-flow/core/dist/style.css`
and the default theme once; override colours with the §5 palette.

- **Data**: nodes/edges come from the server, not from parsing TS in the browser. Pipelines are real modules (loops,
  helpers, conditionals), so static AST parsing is unreliable. Use `mt explain --json` shape served as
  `GET /api/pipelines/:declared/graph` → `{ nodes: { id, type, name, step }[], edges: { source, target }[] }` (planned;
  reuses the `explain` loader, runs no Runner). Refresh debounced (500 ms) after save, not per keystroke.
- **Node types** (custom node per step kind): `source`, `tool`, `flatMap`, `tap`, `subflow`, `fork`, `target`.
  Header = kind badge + name; body = key config (URI, batch size); right/left `Handle`s for edges.
- **Run state**: `data.state` maps to the §5 colours (border + dot). Live updates from the run's `/events` SSE
  mutate node data only (`updateNodeData`); positions never change on state updates.
- **Layout**: `dagre` (`rankdir: LR`), computed when step count or edges change or on `Auto-layout`; then
  `fitView({ padding: 0.2 })` after nodes are measured (`onNodesInitialized`). Cache positions per node id so edits
  that keep ids do not reshuffle.
- **Interaction v1**: pan, zoom, select; `nodesDraggable` on, `nodesConnectable` off, `elementsSelectable` on.
  Selecting a node reveals its call site in the editor (`editor.revealLineInCenter`) when `step.loc` is present.
- **Resize**: `ResizeObserver` on the pane, debounced 150 ms, then `fitView`. Container needs explicit height.
- Components: Background (dots), Controls (bottom-left), MiniMap (bottom-right, hidden under 1100 px).

### 10.6 Splitter

`splitpanes` (Vue 3) for editor/graph, horizontal split, min 25 % each, default 45/55, size persisted in
`localStorage` key `mt-split`. Keyboard: focus splitter, `←`/`→` resize by 2 %, `Home`/`End` collapse a side.
Dragging must not trigger a graph re-layout; only `fitView` after drag ends (`@resized`).

### 10.7 Status bar

One line, left to right: state dot + `STATE` (§5 colour), run id (short), `step N/M`, `items N`, router cost today,
then right-aligned: connection (`SSE ● / ○`), cursor `Ln, Col`. Empty state text: `No run selected.`

### 10.8 Delivery order

1. Shell: workspace store (open-or-focus, preview, close, restore) + tab strip, toolbar, sidebar rail/expand, splitter,
   status bar; existing screens as view tabs (no Monaco/Flow yet).
2. Monaco editor pane, lazy-loaded, read-only source from API.
3. Graph API (`/graph`) + Vue Flow read-only render + dagre layout.
4. Run wiring: toolbar buttons, node run-state via SSE, status bar, stop endpoint.
5. Save/edit loop and node↔editor reveal; label tests per §8.

Pitfalls: tab ids derived from the click instead of the target (duplicate tabs); `activeTab` state duplicated per
screen instead of one workspace store; Monaco worker config in production builds; `fitView` before nodes are measured; re-layout on every
change causing flicker; Vue Flow container without height renders nothing; shipping Monaco in the main bundle;
state persisted in `localStorage` must tolerate it being unavailable.

Reference docs: [Vue Flow guide](https://vueflow.dev/guide/) (getting started, nodes, `useVueFlow`, utils).

### 10.9 Workspace: tabs, accordion, and the sidebar

One navigation state for both skins. The web renders it as a horizontal **tab strip**, the TUI as a vertical
**accordion**. They are the same `tabs[] + activeId`, so no screen gets a "web-only" or "sidebar-only" home.

```ts
type TabKind = 'view' | 'doc'
interface TabRef {
  id: string        // stable, derived from the thing — never from the click
  kind: TabKind
  title: string
  preview?: boolean // single transient tab, see rule 4
}
interface WorkspaceState { tabs: TabRef[]; activeId: string }
```

| kind | `id` | title | instances |
|---|---|---|---|
| view | `view:pipelines` | `Pipelines` | 1 |
| view | `view:runs` | `Runs` | 1 |
| view | `view:router` | `Router` | 1 |
| view | `view:workers` | `Workers` | 1 |
| view | `view:settings` | `Settings` | 1 |
| doc | `pipeline:<declared>` | `<basename>.ts` | 1 |
| doc | `run:<runId>` | `<short id>` | 1 |

Rules:

1. **Open means reveal.** Every entry point — rail icon, `1`–`4`, quick-open, deep link, row click — calls the same
   `openTab(ref)`. If the id is already open it becomes active *in place*: never appended twice, never reordered.
   Clicking the active tab is a no-op (no remount, refetch or scroll reset).
2. **The sidebar is navigation, not a tab.** Rail icons map to the singleton `view:` ids; the expanded panel lists
   documents and opens `doc` tabs. No screen exists *only* under the sidebar — the TUI has none and deep links must
   work.
3. **Stable order.** Tab order = open order. Closing a tab does not reorder the rest; the rail order (§2) is fixed and
   independent of it.
4. **Preview tab.** A single click on a pipeline or run row opens/replaces one *preview* tab (italic title; `*` prefix
   in the TUI). The next single click replaces it instead of adding another; double-click / `Enter` / first edit pins
   it (`preview = false`). At most one preview exists. Rail icons, number keys and deep links always open pinned tabs.
   This is what stops "20 pipelines visited → 20 tabs".
5. **Close.** `×` or middle-click (web), `Ctrl+W` / `x` (TUI). Closing the active tab activates the right neighbour,
   else the left; closing the last tab opens `view:pipelines` — the workspace is never empty. Closing a `run:` tab
   drops its SSE subscription; dirty `pipeline:` tabs confirm first.
6. **Keep-alive.** Switching tabs preserves scroll, filters, editor buffer/cursor and subscriptions. Web:
   `<KeepAlive>` over the tab views with a bounded LRU (max 10 `doc` tabs, oldest clean background tab evicted on the
   11th open). TUI: components stay mounted; view state lives in the store, not in the widget.
7. **Refresh budget.** The active tab polls live data at the §6 cadence (3 s active); background tabs at 30 s or are
   paused. Exactly one SSE subscription per open `run:` id, owned by that tab.
8. **Restore.** Web persists `{ tabs: string[], activeId }` under `localStorage` key `mt-workspace` (try/catch). Only
   ids are stored; titles are re-resolved on load. Unknown ids (renamed pipeline, pruned run) are dropped; if nothing
   remains, `view:pipelines` opens. TUI keeps workspace state in memory for now.
9. **No nesting.** One tab strip per window. In the TUI the views column and the workspace accordion are the same
   control; never render a second strip inside a pane.

#### Web: tab strip

```text
┌─ Toolbar ────────────────────────────────────────────────────────────────┐
│ Mt ▸ books.ts       [▶ Run] [⏸ Pause] …                                    │
├──────────────────────────────────────────────────────────────────────────┤
│ ▎books.ts × │ pipelines × │ runs × │ router × │ run 8f3a × │  ⌄           │  tab strip
└──────────────────────────────────────────────────────────────────────────┘
```

- 32 px tall, under the toolbar and above the toast row and splitter. Active: `bg-gray-800`, bright text, 2 px top
  accent in `text-blue-400`; inactive `text-gray-500`, hover `text-gray-300`.
- Each tab: kind icon, title (truncated, `max-w-[200px]`), close `×` (shown on hover unless active), dirty dot for
  unsaved pipelines, italic for preview.
- Overflow: horizontal scroll plus a `⌄` menu listing every tab. `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle in open order,
  `Ctrl+1…9` jumps to the nth tab, `Ctrl+W` closes. Never shrink a tab below 80 px — scroll instead.
- Never an empty frame: `view:pipelines` is the floor.

#### TUI: accordion (same state)

A horizontal strip truncates titles to uselessness and costs a row on every screen. The TUI renders the **same list**
vertically: one line per open tab, with the active one expanded in place.

```text
┌ Views ──────────────┬ Run detail · 8f3a ────────────────────────────────┐
│ ▾ Pipelines         │ state  RUNNING   step 3/7   items 120            │
│   ▸ Runs            │ ─────────────────────────────────────────────── │
│   ▸ books.ts        │ ✓ parse   ✓ translate   • validate   …          │
│   ▸ run 8f3a        │                                                 │
└─────────────────────┴─────────────────────────────────────────────────┘
```

- Width ≥ 100 cols: two columns — views column (24–32 cols, resizable with the §10.6 keys) + active view. Below 100
  cols: one column, accordion mode — every tab is a one-line header and only `activeId` is expanded.
- At most one section is expanded; expanding a header *is* `openTab`, so it cannot duplicate anything.
- Keys: `↑`/`↓` move over headers, `Enter` activates, `Tab`/`Shift+Tab` cycle, `1`–`4` open-or-focus singleton views,
  `Ctrl+W`/`x` closes, `Ctrl+B` toggles the views column, `Ctrl+P` quick-opens (fuzzy over open tabs, then pipelines
  and runs).
- Rows inside the expanded section reuse §4–§6 verbatim. The accordion is a second renderer, not a second data path.

#### Why not tabs *and* an accordion at once

- Tabs answer "which parallel context am I in?"; the accordion answers "what is open and what is inside it?" Showing
  both costs width and splits the single source of truth.
- Choose by host, not by taste: web = tab strip at every width (below 768 px the sidebar is an overlay drawer);
  TUI = views column + accordion. Never a second strip inside a pane.
- Both must survive a cold restore and a deep link to `run:<id>` / `pipeline:<declared>`, which open-or-focus the
  matching tab.

#### Acceptance tests (both skins)

| # | Action | Assert |
|---|---|---|
| 1 | Click the Pipelines rail icon 3× | exactly 1 tab, active, no extra fetch |
| 2 | Pipelines active → click Runs icon | 2 tabs, Pipelines still first |
| 3 | Open `pipeline:a`, then click it again | 1 tab, same scroll/state |
| 4 | Single-click pipeline A row, then B row | one preview tab, B replaces A |
| 5 | Pin A, then single-click B | A pinned + B preview, 2 tabs |
| 6 | Close the middle tab | right neighbour active, order preserved |
| 7 | Close the last tab | `view:pipelines` opens |
| 8 | Restore with a stale `pipeline:gone` id | id dropped, other tabs intact |
| 9 | TUI: press `2` three times | one Runs tab, active, order unchanged |
| 10 | Reload / detach, reopen (web) | same tab ids and active tab |

## 11. Hosts: web and VS Code (shared components)

`packages/components/` is the single UI source. Three packages, one contract:

| Package | Role |
|---|---|
| `packages/components` | Vue 3 components + a host-adapter interface; built twice: web bundle (served by `packages/webui`) and webview bundle (consumed by `packages/vscode`) |
| `packages/webui` | Web host: serves the bundle, `/api/*`, SSE; adapter = HTTP |
| `packages/vscode` | VS Code host: webview provider + native editor; adapter = `postMessage` bridge |

### 11.1 Rules

- Components are **host-agnostic**: no `fetch`, no `window.location`, no `acquireVsCodeApi()` inside a component. They
  take props, emit events and call a `HostAdapter` obtained via `provide`/`inject` (`useHost()`).
- `HostAdapter` (TS interface, one file in `packages/components/src/host/`): `listPipelines`, `getSource`, `getGraph`,
  `startRun`, `pauseRun`, `resumeRun`, `stopRun`, `subscribeEvents(runId, cb)`, `revealLine(file, line)`, `notify(msg)`.
  Implementations: `http-host.ts` (web: `/api/*` + SSE) and `vscode-host.ts` (webview: `postMessage` request/response
  with correlation ids). A `mock-host.ts` backs tests and Vite dev.
- No Tailwind/global CSS assumptions that break in a webview: colours come from the §5 palette via CSS variables; the
  VS Code host maps them to `--vscode-*` theme variables so light/dark/high-contrast follow the editor theme.
- Labels, colours and states (§4–§6) are identical in both hosts; label tests run against the shared components once.

### 11.2 What differs per host

| Concern | Web (`webui`) | VS Code (`vscode`) |
|---|---|---|
| Editor pane | Monaco (§10.4), lazy | **native VS Code text editor** on the real `.ts` file; no Monaco in the webview |
| Graph pane | Vue Flow in the right split | Vue Flow in a webview panel opened beside the editor (`ViewColumn.Beside`) |
| Sidebar / rail | §10.2 component | native Activity Bar view container `Mt` (tree views: Pipelines, Runs); webview only for Router/Workers/Run detail |
| Toolbar | §10.3 component | editor title buttons + code lens (`▶ Run pipeline`) + command palette; graph webview keeps its own mini toolbar (`Auto-layout`) |
| Status bar | §10.7 component | `StatusBarItem` (state, step N/M) |
| Data | `mt serve` over HTTP | `mt explain --json` / `mt run` via the `mt` CLI in the workspace; optional `mt serve` URL setting for runs/SSE |
| Graph refresh | after Save API call | on document save (`onDidSaveTextDocument`, debounced 500 ms) and on active-editor change |
| Node select | reveal line in Monaco | `showTextDocument` + `revealRange` using `step.loc` |

### 11.3 Webview requirements

- Bundle: `vite build --mode webview` → `packages/components/dist-webview/` (single JS + CSS, no external CDN, no
  remote fonts, no Monaco). `packages/vscode` copies it into `media/` at package time (`vsce package`); it does **not**
  import `@mt/*` at runtime.
- Content-Security-Policy with a nonce, `webview.asWebviewUri` for assets, `localResourceRoots` = `media/` only.
- State survives hide/show: `retainContextWhenHidden` is off; persist view state with `vscode.getState()` (graph
  viewport, selected node) instead.
- Message protocol typed in one shared file (`packages/components/src/host/messages.ts`); the extension copies/relays it,
  never untyped payloads (same rule as the Chrome extension).
- Remote/untrusted workspaces: graph via `mt explain` executes the pipeline module top level. Ask workspace trust
  (`capabilities.untrustedWorkspaces: { supported: false }` or a prompt) before running it.

### 11.4 Delivery order (hosts)

1. Extract `HostAdapter` + `http-host.ts` in `packages/components`; web keeps working unchanged.
2. Webview build target + `vscode-host.ts` + typed messages.
3. VS Code: `GraphPanel` opened from a code lens (`Show graph`), fed by `mt explain --json`, node select reveals line.
4. VS Code: Activity Bar tree views + status bar + run controls (needs `mt serve` URL or CLI run).
