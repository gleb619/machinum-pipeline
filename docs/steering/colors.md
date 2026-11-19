# Colour, shadow and theme tokens (web + TUI)

Audience: anyone touching `packages/components/`, `packages/tui/`, `packages/vscode/` or
`packages/components/tailwind.config.js`.
Rule: **class names stay, values change.** Components keep stock Tailwind names (`gray-900`, `blue-400`, …); the
palette behind those names is ours. Never add a second naming scheme, never hard-code a hex in a component, never add
`dark:` variants. State colours are the same contract as [layout.md §5](layout.md#5-state-colours); host rules are
[layout.md §11](layout.md#11-hosts-web-and-vs-code-shared-components).

`packages/components/tailwind.config.js` is the **only** place tokens are registered into Tailwind; literal values live
once, as RGB triplets, in `packages/components/src/styles/tokens.css`. Components read neither file — they write classes.

## 1. Palette tokens

Dark-first. Triplets (`11 14 18`) keep opacity modifiers such as `bg-gray-800/50` working. Every shade not listed in §2
does not exist — a typo'd class renders nothing, which is the point.

| Token | CSS var | Value | Tailwind class | Use |
|---|---|---|---|---|
| page | `--mt-bg` | `#0b0e12` | `gray-900` | app background, inputs |
| sunken | `--mt-bg-sunken` | `#06080b` | `gray-950` | toast row, inset wells |
| surface | `--mt-surface` | `#1e242c` | `gray-800` | panels, cards, active tab, row fill at `/50` |
| raised surface | `--mt-raised` | `#2f3742` | `gray-700` | popovers, `⌄` menu, tooltips, hover border |
| border | `--mt-border` | `#1e242c` | `gray-800` | 1 px row/panel edges (same value as surface — intentional) |
| dim text | `--mt-text-dim` | `#828c9c` | `gray-600` | paths, timestamps, placeholders |
| muted text | `--mt-text-muted` | `#949eac` | `gray-500` | inactive tabs, `pending`, secondary labels |
| primary text | `--mt-text` | `#eef2f7` | `gray-100` | body, headings, active labels |
| link / brand | `--mt-link` | `#5ea8ff` | `blue-400` | links, active tab accent, brand |
| focus ring | `--mt-focus` | `#3d8bfd` | `blue-500` | focus ring, input focus border |
| success / run | `--mt-run` | `#4ade80` | `green-400` | `running`, success toast |
| warning / paused | `--mt-warn` | `#fbbf24` | `yellow-400` | `paused` |
| danger / failed | `--mt-danger` | `#f87171` | `red-400` | `failed`, error toast, destructive |

## 2. Tailwind override mapping

Two options exist. Pick **A** and stay with it:

| | A. Override `theme.colors` (chosen) | B. `theme.extend.colors.mt-*` |
|---|---|---|
| Class names | unchanged (`bg-gray-900`) | every call site renamed (`bg-mt-page`) |
| Default palette | gone — `bg-slate-700` renders nothing | still available, easy to drift back |
| Third-party CSS | inherits our palette | ignores it |
| Cost | must define every shade we use, up front | low, but permanent split naming |

```js
/** @type {import('tailwindcss').Config} */
const rgb = (v) => `rgb(var(${v}) / <alpha-value>)`
const ramp = (name, shades) => Object.fromEntries(shades.map((s) => [s, rgb(`--mt-${name}-${s}`)]))
const shades = [300, 400, 500, 600, 700, 800, 900]

export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    // override, not extend: unknown names are deliberate build-time no-ops
    colors: {
      transparent: 'transparent', current: 'currentColor', white: '#ffffff', black: '#000000',
      gray: ramp('gray', [100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
      blue: ramp('blue', shades), green: ramp('green', shades),
      yellow: ramp('yellow', shades), red: ramp('red', shades),
    },
    boxShadow: { /* §3 */ },
  },
  plugins: [],
}
```

```css
/* packages/components/src/styles/tokens.css — the single value source */
:root {
  --mt-gray-100: 238 242 247; --mt-gray-200: 216 222 231; --mt-gray-300: 195 203 214;
  --mt-gray-400: 170 180 193; --mt-gray-500: 148 158 172; --mt-gray-600: 130 140 156;
  --mt-gray-700: 47 55 66;    --mt-gray-800: 30 36 44;    --mt-gray-900: 11 14 18;
  --mt-gray-950: 6 8 11;      --mt-blue-300: 140 196 255; --mt-blue-400: 94 168 255;
  --mt-blue-500: 61 139 253;  --mt-blue-600: 47 111 208;  --mt-blue-700: 37 90 171;
  --mt-blue-800: 27 63 120;   --mt-blue-900: 18 40 77;    --mt-green-300: 134 239 172;
  --mt-green-400: 74 222 128; --mt-green-500: 26 158 75;  --mt-green-600: 21 128 61;
  --mt-green-700: 17 99 50;   --mt-green-800: 13 79 41;   --mt-green-900: 10 61 33;
  --mt-yellow-300: 253 230 138; --mt-yellow-400: 251 191 36; --mt-yellow-500: 209 154 10;
  --mt-yellow-600: 161 98 7;  --mt-yellow-700: 138 86 6;  --mt-yellow-800: 107 67 5;
  --mt-yellow-900: 74 47 4;   --mt-red-300: 252 165 165;  --mt-red-400: 248 113 113;
  --mt-red-500: 229 72 77;    --mt-red-600: 204 43 43;    --mt-red-700: 165 31 31;
  --mt-red-800: 122 26 26;    --mt-red-900: 69 26 26;
  /* semantic aliases: shadows, Vue Flow, host bridges — not for components */
  --mt-bg: var(--mt-gray-900);       --mt-bg-sunken: var(--mt-gray-950);
  --mt-surface: var(--mt-gray-800);  --mt-raised: var(--mt-gray-700);
  --mt-border: var(--mt-gray-800);   --mt-text: var(--mt-gray-100);
  --mt-text-2: var(--mt-gray-300);   --mt-text-muted: var(--mt-gray-500);
  --mt-text-dim: var(--mt-gray-600); --mt-link: var(--mt-blue-400);
  --mt-focus: var(--mt-blue-500);    --mt-run: var(--mt-green-400);
  --mt-warn: var(--mt-yellow-400);   --mt-danger: var(--mt-red-400);
  --vf-node-bg: var(--mt-surface);   --vf-node-border: var(--mt-border);
}
```

## 3. Shadows

Dark UI: elevation reads as *deep, soft, slightly cool*; a 1 px inner top highlight fakes the lit edge. Remap the scale
in `theme.boxShadow` (not `extend`) so `shadow-sm/md/lg/xl` change meaning globally.

```js
boxShadow: {
  sm:    '0 1px 2px 0 rgb(0 0 0 / 0.50), inset 0 1px 0 0 rgb(255 255 255 / 0.03)',
  md:    '0 2px 6px -1px rgb(0 0 0 / 0.55), 0 1px 0 0 rgb(255 255 255 / 0.04)',
  lg:    '0 12px 32px -8px rgb(0 0 0 / 0.70), 0 2px 8px -2px rgb(0 0 0 / 0.50)',
  xl:    '0 24px 64px -12px rgb(0 0 0 / 0.80), 0 4px 12px -4px rgb(0 0 0 / 0.60)',
  inner: 'inset 0 1px 2px 0 rgb(0 0 0 / 0.60)',
  none:  'none',
  // ring is drawn outside the element; the offset uses the page colour, never `transparent`
  focus: '0 0 0 2px rgb(var(--mt-bg)), 0 0 0 4px rgb(var(--mt-focus) / 0.85)',
  'glow-run': '0 0 0 3px rgb(var(--mt-run) / 0.15)',
}
```

`shadow-sm` on rows/inputs, `md` on cards, `lg` on popovers and the tab overflow menu, `xl` on modals only. Never
stack `shadow-*` with a second decorative `box-shadow`. In the VS Code webview use `shadow-none`: VS Code separates
regions by border, not depth.

## 4. State colours

Five states, three renderers. Glyph + uppercase label is mandatory everywhere: colour is the third signal, never the
only one. The mapping lives in one shared helper per skin (`stateColor()` / `state()`), not per screen.

| State | Web (Tailwind) | Dot | TUI (ANSI 16) | VS Code webview |
|---|---|---|---|---|
| `running` | `text-green-400` | `●` | bright green `92` | `--vscode-charts-green` |
| `paused` | `text-yellow-400` | `⏸` | bright yellow `93` | `--vscode-charts-yellow` |
| `done` | `text-blue-400` | `✓` | bright blue `94` | `--vscode-charts-blue` |
| `failed` | `text-red-400` | `✕` | bright red `91` | `--vscode-errorForeground` |
| `pending` / other | `text-gray-500` | `○` | bright black `90` (dim) | `--vscode-descriptionForeground` |

TUI: page and panel = default background (separated by a `─`/`│` rule in bright black `90`), primary text = default
foreground, dim = `90`, link = bright blue `94` + underline, focus = reverse video on the row (works in every terminal
palette). Honour `NO_COLOR`: keep glyphs and labels, drop SGR colour.

VS Code: `--vscode-*` values are hex and cannot feed `rgb(var(--mt-x) / a)` directly. The host bridge
(`theme-bridge.ts`) reads them with `getComputedStyle`, parses them into triplets, writes `--mt-*` on the webview root,
and re-runs on theme-change messages. Until it exists the webview ships dark tokens and is marked "web only".

| Semantic | VS Code variable |
|---|---|
| page / surface / raised | `--vscode-editor-background` / `--vscode-sideBar-background` / `--vscode-editorWidget-background` |
| border | `--vscode-panel-border` |
| text (primary/muted/dim) | `--vscode-editor-foreground` / `--vscode-descriptionForeground` / `--vscode-disabledForeground` |
| link / focus | `--vscode-textLink-foreground` / `--vscode-focusBorder` |

## 5. Contrast and accessibility

| Rule | Threshold | Notes |
|---|---|---|
| Body text (`gray-100/300/500/600`) | ≥ 4.5:1 | measured on `gray-900`, `gray-800` and the `/50` row blend `#14191f` |
| Large text (≥ 24 px, or 18.66 px bold) | ≥ 3:1 | tab titles, status bar |
| UI edges, icons, focus ring, state dots | ≥ 3:1 | against the *adjacent* fill, not the page |
| Disabled controls | ≥ 3:1 | readable, just not actionable |
| `text-gray-600` on `bg-gray-700` | **forbidden** | 3.5:1 — use `gray-300` on raised surfaces |
| Alpha fills | fills and borders only | never `text-*/50` for real content |

Checklist:

1. State is never colour-only: dot glyph + uppercase `STATE` label + colour (§4).
2. Focus is always visible: `shadow-focus`, or `ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-900`.
   `focus:outline-none` without a replacement ring is a bug (currently in the Router token input).
3. `prefers-reduced-motion: reduce` disables width/splitter/tab transitions; state still changes, instantly.
4. Usable at 200 % zoom and 80×24 TUI: no fixed pixel heights on text containers, truncation never hides the state
   label, every pointer action has a keyboard path ([layout.md §7](layout.md#7-interaction-mapping)).
5. Verify with a contrast checker, then axe/Lighthouse on the built webui. "Looks fine" is not a check.

## 6. Migration checklist

1. Add `packages/components/src/styles/tokens.css` (§2 block); import it in `main.ts` before Tailwind.
2. Replace `theme.extend: {}` with `theme.colors` + `theme.boxShadow` (§2–§3); keep `content` unchanged.
3. Audit used classes (`grep -rhoE '(bg|text|border|ring|shadow)-[a-z]+-[0-9]+' packages/components/src | sort -u`);
   every result must resolve to §2. A missing shade is added to both files, never patched in a component.
4. Move remaining hex/`rgb()` literals (Vue `style=` blocks, chart series, Vue Flow overrides) into `tokens.css`.
5. Point Vue Flow at the semantic vars (`--vf-node-bg`, `--vf-node-border`, handles = `--mt-link`).
6. Implement §4 in `packages/tui/src/theme.ts` (no raw escapes in widgets) and add `theme-bridge.ts` + theme listener
   before enabling the webview build. Re-check §5 in both skins; no token name should require editing `layout.md`.

## 7. Open questions

1. Keep stock shade names for ever, or plan a v2 rename to `mt-*`? Overriding buys speed now and makes the rename a
   codemod; extending does the opposite. Current decision: override, revisit only with a codemod owner.
2. Should the web follow `--vscode-editor-background` when hosted in VS Code (true host parity, one more bridge
   input), or keep `#0b0e12` everywhere?
3. Dim text at 4.5:1 is not very dim (`#828c9c`). Allow 3:1 for purely decorative paths/timestamps, or keep the
   stricter rule and lean on size/weight?
4. Light theme is deliberately unscheduled: tokens flip (no `dark:` variants), but every ramp needs a second table and
   shadows must get much shallower. Needs an owner before any light-only styling ships.
5. High-contrast VS Code themes (`--vscode-contrastBorder`, forced colours): honour fully (drop our palette) or only
   for borders? And who owns `tokens.css` — `packages/components` (current assumption) or a shared `@mt/theme`?
