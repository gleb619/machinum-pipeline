# T301 — Implement Folio colour tokens (SCSS → Tailwind → skins)

## Keywords

Keywords: packages/components/src/styles/_palette.scss, packages/components/src/styles/tokens.scss, packages/components/tailwind.config.js, packages/components/src/App.vue, packages/components/src/main.ts, packages/tui/src/theme.ts, packages/vscode/src/theme-bridge.ts, sass, data-theme, rgb(var(--gray-50), shadow-focus, Folio

## Goal

Implement **step 10 of `docs/steering/colors.md`** exactly: Folio is accepted, light is the default theme, dark flips the
same stock Tailwind class names, values are generated in SCSS from anchors, and no component hard-codes a colour.

Read `docs/steering/colors.md` (§1–§10) and `docs/steering/layout.md` §5 before editing. Do not change either doc.

## Time

Planned: 1h

## Steps

- [ ] `packages/components/package.json` + `pnpm-lock.yaml` — add `sass ^1.80` to `@mt/components` devDependencies
  (`pnpm add -D sass --filter @mt/components`). Commit the lockfile change.
- [ ] `packages/components/src/styles/_palette.scss` (new) — anchors + functions from colors.md §4:
  `mixc()`, `gray-light()`, `gray-dark()`, `accent-light()`, `accent-dark()`, `triplet()`, `elevation($level, $theme)`.
  Generate all 11 steps (50–950) for `gray/blue/green/yellow/red`; `triplet()` must emit `R G B` for Tailwind alpha.
- [ ] `packages/components/src/styles/tokens.scss` (new) — emit `:root` (light, default) and
  `[data-theme='dark']` with every `--gray-* … --red-*` variable plus `--mt-shadow-sm|md|lg|xl`. Also emit
  `[data-host='vscode'] { --mt-shadow-sm…xl: none }`. Light must be the no-attribute default.
- [ ] `packages/components/src/main.ts` — import `./styles/tokens.scss` before `./style.css`.
- [ ] `packages/components/tailwind.config.js` — replace `theme.extend: {}` with the exact mapping in colors.md §5:
  override `colors` for the five families as `rgb(var(--<family>-<step>) / <alpha-value>)`, keep
  `transparent/current/inherit/white/black`, map `boxShadow` (`DEFAULT/sm/md/lg/xl/focus/none`) to the CSS vars.
  Do **not** configure `darkMode`; no `dark:` variants anywhere.
- [ ] `packages/components/src/App.vue` — one-time polarity migration from colors.md §10.3, keeping stock class names.
  Apply at least: page `bg-gray-50 text-gray-900`, rows `border-gray-300 bg-gray-100/70 hover:border-gray-400`,
  dim `text-gray-500`, muted `text-gray-600`, ids `text-gray-800`, headings `text-gray-900`,
  inputs `border-gray-400 bg-gray-100 text-gray-900 placeholder:text-gray-500`, active tab `text-gray-950`.
  - Links: keep `text-blue-400`; replace `hover:text-blue-300` with `hover:opacity-80` (a shade flip would fail in one theme).
  - Solid buttons: `bg-green-400 text-gray-50 hover:opacity-90 active:opacity-80`; pause uses `yellow-400`,
    destructive uses `red-400`. Remove `text-white`, `bg-green-700/600/800`, `bg-yellow-700/600/800`.
  - Focus: `focus:border-blue-400 focus:ring-2 focus:ring-blue-400/30 focus:ring-offset-2
    focus:ring-offset-gray-50`; never `focus:outline-none` without a ring.
  - Toast: `bg-green-50 border-green-300 text-green-400` for success, `red-50/red-300/red-400` for errors.
  - `stateColor()` class strings stay as they are.
- [ ] `packages/tui/src/theme.ts` (new) — colors.md §7: `StateName`, `stateAnsi()` mapping to `92/93/96/91/90`,
  `stateLabel()` uppercase, `detectNoColor(env = process.env)` for `NO_COLOR` / `TERM=dumb`, and a `colorize()` that
  returns plain text when colour is off. No raw escapes in widgets; export from `packages/tui/src/index.ts`.
- [ ] `packages/vscode/src/theme-bridge.ts` (new) + `packages/vscode/tests/theme-bridge.test.ts` — colors.md §8:
  pure `hexToTriplet(hex)` (`#0b0e12` → `11 14 18`, accepts `#rgb`), `applyVsCodeTheme(root, source)` writing
  `--gray-50…--gray-950`, `--blue-400`, `--green-400`, `--yellow-400`, `--red-400` from a minimal
  `{ getPropertyValue(name: string): string }` source, and `bindThemeChange(source, onChange)` that re-applies.
  Keep it DOM-lib-free (local interfaces only) so `packages/vscode` typechecks. Test hex parsing, triplet output,
  fallback when a variable is empty, and re-apply.

## Constraints

- Only the files above. Do not touch `docs/steering/*`, `docs/kanban.md`, other packages, or generated `dist/`.
- No hard-coded hex in `.vue`/`.ts` components; colours live in SCSS only.
- No new naming scheme: stock Tailwind shade names only (`bg-gray-50`, `text-blue-400`, `shadow-lg`).
- Dark is `html[data-theme='dark']`; light needs no attribute. No `dark:` utilities.
- Preserve existing layout, labels, behaviour and API calls. This is a theme migration, not a redesign.
- Commit on the task branch with a conventional message (`feat(components): ...`). Leave the worktree clean.

## Done when

- `pnpm --filter @mt/components build` succeeds (SCSS compiles; Tailwind config valid).
- `pnpm --filter @mt/components typecheck`, `pnpm --filter @mt/tui typecheck`,
  `pnpm --filter mt-vscode typecheck`, `pnpm --filter mt-vscode test` pass.
- Built CSS contains all `--gray/blue/green/yellow/red-50…950` variables under both `:root` and
  `[data-theme='dark']`; `rgb(var(` appears in the generated utilities.
- No `dark:` class and no raw hex/`rgb()` literal in `packages/components/src/App.vue`.
- Manually toggling `document.documentElement.dataset.theme = 'dark'` on the built admin flips the page without a
  reload and without a second class string.
