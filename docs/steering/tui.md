# @mt/tui
← [Architecture](../guiding/architecture.md)

Path: `packages/tui/`

Terminal UI for `mt serve`. **Skeleton** — no screens yet; the package exists so the layout
contract has a home and the layer rules are pinned before real screens land.

## Purpose

- Second skin of the admin UI (web skin: `@mt/components`) — see the two-skins contract in
  [docs/layout.md](../layout.md): same screens, names, buttons, state colours
- Talks to `mt serve` over HTTP only (`/api/*`) — never imports `@mt/webui`, `@mt/core` or
  any other `@mt/*` package
- Runs in the terminal; keyboard-first interaction (key mapping in [docs/layout.md](../layout.md) §7)

## Current state

- `src/index.ts` — `pingServer()` health probe (`GET /api/health`) + `TuiOptions`
- Build/typecheck wired into turbo (`tsc`); no test script until screens exist
- Screen implementation: **OpenTUI + SolidJS** (`@opentui/core` + `@opentui/solid`), loaded via the OpenTUI skill
  (`opentui`). **Never React** (`@opentui/react`, `react`, `ink`) — signals/`createSignal`/`<For>`/`<Show>` only.
  Polling cadence and footer keys follow [docs/layout.md](../layout.md) §6/§7

## Rules

- Framework: SolidJS only. JSX compiles with `jsxImportSource: "@opentui/solid"` (tsconfig) and the OpenTUI Solid
  Babel/Bun preload; files holding JSX are `*.tsx`. Adding React is a review reject

- HTTP-only client: the import-layer rule in [structure.md](structure.md) forbids `@mt/*`
  imports here; a `layers.arch` test should pin it when the first real screen lands
- Labels, colours and empty/error strings come from [docs/layout.md](../layout.md) §4–§6 —
  never invent variants; add a label-assertion test per [docs/layout.md](../layout.md) §8
- Run against the same server as the webui: `mt serve` (local or `--detach`); pause/resume
  404 means "not live in this process" — surface as toast, not crash

## Running

```bash
pnpm build --filter=@mt/tui    # tsc -> dist/
pnpm typecheck --filter=@mt/tui
```
