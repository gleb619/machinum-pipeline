# Colour, shadow and theme contract (web + TUI)

Audience: anyone touching `packages/components/`, `packages/tui/`, `packages/vscode/` or the Tailwind config.
Rule: **stock Tailwind class names stay, values are ours — permanently.** No `mt-*` palette, no shade rename, no
second naming scheme, no `dark:` variants. The palette is written once in SCSS, emitted as CSS variables, and mapped
onto the stock `gray/blue/green/yellow/red` ramps in `tailwind.config.js`.

Live preview: [colors-preview.html](colors-preview.html) — light and dark, tokens, ramps, product mock, shadows.
Status: **draft**; nothing here is implemented until the palette is accepted.

## 1. Decisions (locked)

| Decision | Value |
|---|---|
| Class names | stock Tailwind forever (`bg-gray-50`, `text-blue-400`, `shadow-md`) |
| Value source | SCSS functions in `packages/components/src/styles/_palette.scss` |
| Runtime form | CSS variables (`--gray-50: 247 243 236`) in `tokens.scss` |
| Theme order | **light is the default**; dark is a first-class second theme |
| Theme switch | `html[data-theme='dark']`; no `prefers-color-scheme` unless `data-theme='auto'` |
| Dark variants | none — tokens flip value, components keep one class string |
| VS Code webview | exception: colours follow `--vscode-*`, shadows are flat (§8) |
| Ramp meaning | steps are **roles**, not literal lightness (§3) |
| State signal | glyph + uppercase label + colour, never colour alone |
| Dim text | ≥ 4.5:1; 3:1 is allowed only for non-text UI (borders, dots) |

## 2. Palette direction for a book-processing ETL

The product is a long-session reading/writing tool with machine status on top: books are the subject, runs are the
noise. That argues for paper-and-ink neutrals (lower glare than pure white, warmer than a code editor's cool grey)
and **one** quiet accent; status colours are the only loud pixels. Three candidates:

| Option | Neutrals | Accent | Reads as | Risk |
|---|---|---|---|---|
| **Folio** (recommended) | warm paper `#f7f3ec` / ink `#1f1b16` | verdigris `#1f5f5b` | library, archival, calm | teal can look clinical if oversaturated — keep it deep and matte |
| Vellum | cool ivory `#f6f5f1` / graphite `#232323` | oxblood `#7d2e35` | editorial, classic print | accent sits too close to `failed` red |
| Midnight Library | indigo-slate `#171a24` / `#e8e6f0` | brass `#a9772f` | late-night reading room | weak as a **light** default; brass needs dark to glow |

Chosen: **Folio**. Verdigris is far enough from the run green and the fail red, warm neutrals separate the admin UI
from the code editor, and the palette survives both themes from the same anchors. Typography is part of the proposal:
serif display headings (system `Georgia` stack), sans UI, mono for ids/URIs — book feel without a webfont.

### 2.1 One accent, three semantic families

- `blue-*` is the **brand/link** ramp (verdigris). The name stays `blue`; the hue does not.
- `green-*` = running / success; `yellow-*` = paused / warning; `red-*` = failed / destructive.
- `gray-*` = everything structural. Large areas use `gray-50/100/200`; text uses `gray-900/700/600/500`.
- Buttons are solid signals with `text-gray-50` on top (paper text in light, ink text in dark — the token flips, so
  contrast holds in both). Hover uses `opacity-90`, not another shade.
- Never tint a whole panel with a state colour; use a 2 px bar, a dot, or a badge.

## 3. The ramp is a role scale

Tailwind numbers normally mean lightness. Here they mean **role**, stable across themes; in dark the physical
lightness inverts. This is what lets one class string serve both themes with no `dark:`.

| Step | Role | Light value | Dark value |
|---|---|---|---|
| `gray-50` | page background | `#f7f3ec` | `#14120f` |
| `gray-100` | surface (card, tab, sidebar) | `#fffdf8` | `#1c1916` |
| `gray-200` | raised (popover, hover row) | `#f2ece1` | `#26221d` |
| `gray-300` | separator border | `#ded4c5` | `#3a332b` |
| `gray-400` | control border / strong edge | `#8f8070` | `#756857` |
| `gray-500` | dim text (paths, timestamps) | `#756a5c` | `#9a8e7f` |
| `gray-600` | muted text (inactive tabs, pending) | `#6b6157` | `#b3a897` |
| `gray-700` | secondary text | `#514a42` | `#cfc5b6` |
| `gray-800` | strong secondary / icon | `#3a342d` | `#e3dbcf` |
| `gray-900` | primary text | `#1f1b16` | `#f2ece1` |
| `gray-950` | maximum emphasis / on-signal | `#0f0d0a` | `#fbf7f0` |

Accent ramps use the same role idea: `50–300` are tinted fills, `400` is the signal colour (text/border/dot), `500`
and up are deeper variants for fills and pressed states. `400` is the only step components should use for status text.

| Family | 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `blue` light | #f2f5f5 | #e9efef | #d7e2e1 | #c0d2d1 | **#1f5f5b** | #1b5450 | #184845 | #143d3a | #10312f | #0c2624 | #091b19 |
| `blue` dark | #16201d | #172824 | #19322f | #1a3d3a | **#6fb3ad** | #50827f | #3a726f | #1f5f5b | #1a514d | #164442 | #133937 |
| `green` light | #f3f7f4 | #eaf2ed | #dae8df | #c5dbce | **#2f7d4f** | #296e46 | #245f3c | #1e5033 | #184129 | #133220 | #0d2316 |
| `green` dark | #19251b | #1c3021 | #1f3f2a | #234e33 | **#61b97f** | #5d9a76 | #488d64 | #2f7d4f | #286a43 | #225a39 | #1c4b2f |
| `yellow` light | #f9f6f1 | #f5efe7 | #ece3d4 | #e2d3bc | **#97610f** | #85550d | #734a0b | #613e0a | #4f3208 | #3c2706 | #2a1b04 |
| `yellow` dark | #2c200f | #39280f | #4b330f | #5d3e0f | **#d9a441** | #ae8444 | #a3742c | #97610f | #80520d | #6d460b | #5b3a09 |
| `red` light | #faf3f3 | #f6ebea | #efdcda | #e6c8c6 | **#a63a32** | #92332c | #7e2c26 | #6a2520 | #561e1a | #421714 | #2e100e |
| `red` dark | #2e1915 | #3d1d19 | #51231e | #662823 | **#e0736a** | #ba655f | #b1524b | #a63a32 | #8d312a | #782a24 | #64231e |

## 4. SCSS source

Three files, one value source. `sass` is a dev dependency of `@mt/components`; Vite compiles SCSS natively.

```text
packages/components/src/styles/
  _palette.scss   functions + anchors, no output
  tokens.scss     emits :root (light), [data-theme='dark'], [data-host='vscode']
```

```scss
// _palette.scss
@use 'sass:color';
@use 'sass:map';

$anchors: (
  light: (
    gray: (paper: #f7f3ec, surface: #fffdf8, ink: #1f1b16),
    blue: (base: #1f5f5b), green: (base: #2f7d4f),
    yellow: (base: #97610f), red: (base: #a63a32),
  ),
  dark: (
    gray: (page: #14120f, surface: #1c1916, ink: #f2ece1),
    blue: (base: #1f5f5b, signal: #6fb3ad), green: (base: #2f7d4f, signal: #61b97f),
    yellow: (base: #97610f, signal: #d9a441), red: (base: #a63a32, signal: #e0736a),
  ),
);

@function mixc($a, $b, $w) { @return color.mix($a, $b, $w); }

@function gray-light($paper, $surface, $ink) {
  @return (
    50: $paper, 100: $surface,
    200: mixc($ink, $paper, 3.5%), 300: mixc($ink, $paper, 15%),
    400: mixc($ink, $paper, 53%),  500: mixc($ink, $paper, 64%),
    600: mixc($ink, $paper, 67%),  700: mixc($ink, $paper, 76%),
    800: mixc($ink, $paper, 86%),  900: $ink,
    950: mixc(#000, $ink, 52%),
  );
}

@function gray-dark($page, $surface, $ink) {
  @return (
    50: $page, 100: $surface,
    200: mixc($ink, $page, 7%),  300: mixc($ink, $page, 15%),
    400: mixc($ink, $page, 39%), 500: mixc($ink, $page, 57%),
    600: mixc($ink, $page, 68%), 700: mixc($ink, $page, 82%),
    800: mixc($ink, $page, 91%), 900: $ink,
    950: mixc(#fff, $ink, 60%),
  );
}

// 50-300 tints, 400 = the authored signal, 500-950 deeper.
@function accent-light($base) {
  @return (
    50: mixc($base, #fff, 6%),  100: mixc($base, #fff, 10%),
    200: mixc($base, #fff, 18%), 300: mixc($base, #fff, 28%), 400: $base,
    500: mixc($base, #000, 88%), 600: mixc($base, #000, 76%),
    700: mixc($base, #000, 64%), 800: mixc($base, #000, 52%),
    900: mixc($base, #000, 40%), 950: mixc($base, #000, 28%),
  );
}

@function accent-dark($base, $signal, $bg) {
  @return (
    50: mixc($base, $bg, 18%),  100: mixc($base, $bg, 28%),
    200: mixc($base, $bg, 42%), 300: mixc($base, $bg, 56%), 400: $signal,
    500: mixc($base, #fff, 78%), 600: mixc($base, #fff, 88%), 700: $base,
    800: mixc($base, #000, 85%), 900: mixc($base, #000, 72%),
    950: mixc($base, #000, 60%),
  );
}

// Tailwind needs "R G B" so rgb(var(--gray-50) / <alpha-value>) works.
@function triplet($c) {
  @return #{color.channel($c, 'red', $space: rgb)} #{color.channel($c, 'green', $space: rgb)}
    #{color.channel($c, 'blue', $space: rgb)};
}
```

```scss
// tokens.scss — emitted for both themes; light is the default
@use 'sass:map';
@use 'palette' as p;

@mixin emit($theme) {
  $g: map.get(p.$anchors, $theme, gray);
  --gray-50: #{p.triplet(map.get($g, if($theme == light, paper, page)))};
  /* …one line per step; the maps above drive a loop in the real file… */
}

:root { @include emit(light); }
[data-theme='dark'] { @include emit(dark); }
[data-host='vscode'] { --mt-shadow-sm: none; /* …colours come from the VS Code bridge, §8 */ }
```

The loop is mechanical (`@each $family, $scale in $map`); the point is that **only anchors are authored**. Adding a
shade means adding a weight, not a colour. `color.channel()` needs Dart Sass ≥ 1.79 — pin `sass ^1.80` in
`@mt/components`.

## 5. Tailwind mapping (stock names, our values)

```js
/** @type {import('tailwindcss').Config} */
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const ramp = (name) => Object.fromEntries(STEPS.map((s) => [s, `rgb(var(--${name}-${s}) / <alpha-value>)`]))

export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    // override, not extend: a removed family must fail visibly, not drift back
    colors: {
      transparent: 'transparent', current: 'currentColor', inherit: 'inherit',
      white: '#ffffff', black: '#000000',
      gray: ramp('gray'), blue: ramp('blue'), green: ramp('green'),
      yellow: ramp('yellow'), red: ramp('red'),
    },
    boxShadow: {
      DEFAULT: 'var(--mt-shadow-sm)', none: 'none',
      sm: 'var(--mt-shadow-sm)', md: 'var(--mt-shadow-md)',
      lg: 'var(--mt-shadow-lg)', xl: 'var(--mt-shadow-xl)',
      focus: '0 0 0 2px rgb(var(--gray-50)), 0 0 0 4px rgb(var(--blue-400) / 0.7)',
    },
  },
  plugins: [],
}
```

- Keep the `rgb(var(--x) / <alpha-value>)` form: `bg-gray-200/60`, `border-blue-400/40`, `ring-blue-400/30` must work.
- Add a family only when a component needs it; an undefined family renders nothing, which is deliberate.
- `darkMode` is not configured. A `dark:` class anywhere is a review failure.
- Do not add hex values to `theme` for components; values live in SCSS only.

## 6. Shadows: an SCSS function, not a hand-written scale

Elevation is theme-dependent (warm ink shadow in light, deep black in dark), so the scale is generated:

```scss
@use 'sass:map';

@function elevation($level, $theme) {
  $ink: if($theme == light, #3b2f22, #000000);
  $spec: map.get((
    sm: (1, 2, 0.10, 0.55), md: (2, 6, 0.12, 0.60),
    lg: (12, 32, 0.18, 0.00), xl: (24, 64, 0.22, 0.00),
  ), $level);
  @return 0 nth($spec, 1) * 1px nth($spec, 2) * 1px rgba($ink, nth($spec, 3)),
    inset 0 1px 0 rgba(#fff, nth($spec, 4));
}
```

| Class | Use | Light | Dark |
|---|---|---|---|
| `shadow-sm` | rows, inputs | `0 1px 2px rgba(59,47,34,.10)` + white inset | `0 1px 2px rgba(0,0,0,.55)` + white 4 % inset |
| `shadow-md` | cards, active tab | `0 2px 6px -1px rgba(59,47,34,.12)` | `0 2px 6px -1px rgba(0,0,0,.60)` |
| `shadow-lg` | popovers, tab overflow | `0 12px 32px -8px rgba(59,47,34,.18)` | `0 12px 32px -8px rgba(0,0,0,.70)` |
| `shadow-xl` | modals only | `0 24px 64px -12px rgba(59,47,34,.22)` | `0 24px 64px -12px rgba(0,0,0,.80)` |
| `shadow-focus` | focus ring | `0 0 0 2px page, 0 0 0 4px blue-400/70` | same |

Rules: one shadow per element; never stack a decorative `box-shadow`; rows get `sm`, not `md`; VS Code webview sets
all shadows to `none` and separates with borders.

## 7. State colours

One helper per skin (`stateColor()` in web, `state()` in TUI). The glyph and the uppercase label are mandatory.

| State | Web class | Light | Dark | Dot | TUI (ANSI) | VS Code |
|---|---|---|---|---|---|---|
| `running` | `text-green-400` | #2f7d4f | #61b97f | `●` | bright green `92` | `--vscode-charts-green` |
| `paused` | `text-yellow-400` | #97610f | #d9a441 | `⏸` | bright yellow `93` | `--vscode-charts-yellow` |
| `done` | `text-blue-400` | #1f5f5b | #6fb3ad | `✓` | bright cyan `96` | `--vscode-charts-blue` |
| `failed` | `text-red-400` | #a63a32 | #e0736a | `✕` | bright red `91` | `--vscode-errorForeground` |
| `pending` / other | `text-gray-600` | dim | dim | `○` | bright black `90` | `--vscode-descriptionForeground` |

TUI: page/panel = terminal default, separators = `90`, dim = `90`, link = `94` + underline, focus = reverse video.
Honour `NO_COLOR` (keep glyph + label, drop SGR).

## 8. VS Code is the exception

The webview does not use Folio. It inherits the editor theme so the panel never fights the editor:

| Role | Source |
|---|---|
| page / surface / raised | `--vscode-editor-background` / `--vscode-sideBar-background` / `--vscode-editorWidget-background` |
| border | `--vscode-panel-border` |
| text / muted / dim | `--vscode-editor-foreground` / `--vscode-descriptionForeground` / `--vscode-disabledForeground` |
| link / focus | `--vscode-textLink-foreground` / `--vscode-focusBorder` |
| state | `--vscode-charts-*`, `--vscode-errorForeground`, `--vscode-descriptionForeground` |
| shadows | `none` — borders only |

`--vscode-*` values are hex, while Tailwind expects triplets. The host bridge (`theme-bridge.ts`) reads them with
`getComputedStyle`, converts to `R G B`, writes the stock `--gray-*`/`--blue-*` variables on the webview root, and
re-runs on theme change. The Tailwind classes stay identical in both hosts; only the values differ.

## 9. Contrast and accessibility

Measured on the generated values (WCAG 2.1):

| Pair | Light | Dark | Rule |
|---|---|---|---|
| `gray-900` on `gray-50` (body) | 15.5:1 | 15.9:1 | ≥ 4.5 |
| `gray-700` on `gray-100` (secondary) | 6.1:1 | 10.3:1 | ≥ 4.5 |
| `gray-600` on `gray-100` (muted) | 5.9:1 | 7.5:1 | ≥ 4.5 |
| `gray-500` on `gray-50` (dim) | 4.8:1 | 5.8:1 | ≥ 4.5 |
| `gray-400` on `gray-100` (control edge) | 3.8:1 | 3.2:1 | ≥ 3 |
| `green-400` on `gray-50` | 4.6:1 | 7.8:1 | ≥ 4.5 |
| `yellow-400` on `gray-50` | 4.7:1 | 8.3:1 | ≥ 4.5 |
| `red-400` on `gray-50` | 5.8:1 | 6.1:1 | ≥ 4.5 |
| `blue-400` on `gray-50` (link) | 6.7:1 | 7.8:1 | ≥ 4.5 |
| `gray-50` text on `green-400` (solid button) | 4.6:1 | 7.8:1 | ≥ 4.5 |

- **Dim decision:** `gray-500` stays at 4.5:1 in both themes. 3:1 is allowed only for non-text UI (separators,
  dots, disabled glyphs). Do not use `gray-500` for body copy.
- `gray-300` separators are decorative and may be < 3:1; anything that is a *control* boundary uses `gray-400`.
- State is never colour-only: dot + uppercase label + colour in every skin.
- Focus is always visible (`shadow-focus` or `ring-2 ring-blue-400 ring-offset-2 ring-offset-gray-50`);
  `focus:outline-none` without a replacement is a bug.
- `prefers-reduced-motion: reduce` disables width/splitter/tab transitions.
- Check at 200 % zoom, 80×24 TUI, and with a contrast checker before merge.

## 10. Migration checklist

1. Add `sass ^1.80` to `@mt/components`; create `_palette.scss` + `tokens.scss`; import `tokens.scss` from `main.ts`.
2. Replace `theme: { extend: {} }` with §5; keep `content` unchanged.
3. One-time polarity swap in existing components (classes stay stock, roles change):

   | Old (dark-only) | New (role) |
   |---|---|
   | `bg-gray-900` page | `bg-gray-50` |
   | `text-gray-100` body | `text-gray-900` |
   | `bg-gray-800/50` row | `bg-gray-100/70` |
   | `border-gray-800` / `border-gray-700` | `border-gray-300` / `border-gray-400` |
   | `text-gray-600` dim | `text-gray-500` |
   | `text-gray-500` muted | `text-gray-600` |
   | `text-white` active label | `text-gray-950` |
   | `bg-gray-950` toast well | `bg-gray-200` |

4. Audit classes: `grep -rhoE '(bg|text|border|ring|shadow)-[a-z]+(-[0-9]+)?' packages/components/src | sort -u` —
   every result must resolve to §3/§5; a missing shade is added to SCSS, never patched in a component.
5. Move leftover hex/`rgb()` literals (Vue `style=` blocks, Vue Flow overrides) to the semantic variables.
6. TUI: implement `packages/tui/src/theme.ts` from §7 (no raw escapes in widgets); VS Code: `theme-bridge.ts` (§8).

## 11. Open questions

1. **Palette option** — confirm Folio, or switch to Vellum / Midnight Library (§2). Everything below assumes Folio.
2. **Typography** — is serif display for headings part of the product, or should UI stay sans-only?
3. **Signal steps** — keep the 400-is-signal rule, or also generate `-fg`/`-bg` aliases later if the class contract
   starts to strain?
