/**
 * VS Code webview skin (docs/steering/colors.md §8): the panel follows the editor theme
 * instead of Folio. `--vscode-*` values are hex, Tailwind wants `R G B` triplets, so the
 * host bridge reads them with `getComputedStyle` and rewrites the stock variables.
 *
 * DOM-lib-free on purpose: `packages/vscode` compiles without `lib: ["dom"]`.
 */

export interface ThemeVariableSource {
  getPropertyValue(name: string): string
}

export interface ThemeRoot {
  style: {
    setProperty(name: string, value: string): void
  }
}

export interface ThemeChangeSource {
  addEventListener(type: 'message', handler: () => void): void
  removeEventListener(type: 'message', handler: () => void): void
}

type Rgb = readonly [number, number, number]

const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

function parseHex(hex: string): Rgb | null {
  const digits = HEX_PATTERN.exec(hex.trim())?.[1]
  if (!digits) return null
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

function toTriplet(rgb: Rgb): string {
  return `${rgb[0]} ${rgb[1]} ${rgb[2]}`
}

/** `#0b0e12` → `11 14 18`; accepts `#rgb`; `null` for anything else. */
export function hexToTriplet(hex: string): string | null {
  const rgb = parseHex(hex)
  return rgb === null ? null : toTriplet(rgb)
}

function mixRgb(a: Rgb, b: Rgb, weight: number): Rgb {
  const at = (i: 0 | 1 | 2): number => Math.round(a[i] * weight + b[i] * (1 - weight))
  return [at(0), at(1), at(2)]
}

interface Role {
  name: string
  vars: readonly string[]
}

/** Direct `--vscode-*` sources, first non-empty wins. */
const DIRECT_ROLES: readonly Role[] = [
  { name: '--gray-50', vars: ['--vscode-editor-background'] },
  { name: '--gray-100', vars: ['--vscode-sideBar-background', '--vscode-editor-background'] },
  { name: '--gray-200', vars: ['--vscode-editorWidget-background', '--vscode-sideBar-background'] },
  {
    name: '--gray-300',
    vars: ['--vscode-panel-border', '--vscode-editorGroup-border', '--vscode-editorWidget-border'],
  },
  { name: '--gray-500', vars: ['--vscode-disabledForeground', '--vscode-descriptionForeground'] },
  { name: '--gray-600', vars: ['--vscode-descriptionForeground', '--vscode-disabledForeground'] },
  { name: '--gray-900', vars: ['--vscode-editor-foreground', '--vscode-foreground'] },
  { name: '--blue-400', vars: ['--vscode-textLink-foreground', '--vscode-focusBorder'] },
  { name: '--green-400', vars: ['--vscode-charts-green', '--vscode-terminal-ansiGreen'] },
  { name: '--yellow-400', vars: ['--vscode-charts-yellow', '--vscode-terminal-ansiYellow'] },
  { name: '--red-400', vars: ['--vscode-errorForeground', '--vscode-charts-red'] },
]

interface DerivedRole {
  name: string
  from: string
  to: string
  weight: number
}

/** Steps VS Code has no variable for are mixed from the foreground/background pair. */
const DERIVED_ROLES: readonly DerivedRole[] = [
  { name: '--gray-400', from: '--gray-900', to: '--gray-50', weight: 0.45 },
  { name: '--gray-700', from: '--gray-900', to: '--gray-50', weight: 0.78 },
  { name: '--gray-800', from: '--gray-900', to: '--gray-50', weight: 0.9 },
  { name: '--gray-950', from: '--gray-900', to: '--gray-50', weight: 1 },
]

function firstRgb(source: ThemeVariableSource, vars: readonly string[]): Rgb | null {
  for (const name of vars) {
    const rgb = parseHex(source.getPropertyValue(name))
    if (rgb !== null) return rgb
  }
  return null
}

/** Rewrite the Folio variables on `root` from the host theme; unresolved roles keep their value. */
export function applyVsCodeTheme(root: ThemeRoot, source: ThemeVariableSource): void {
  const resolved = new Map<string, Rgb>()
  for (const role of DIRECT_ROLES) {
    const rgb = firstRgb(source, role.vars)
    if (rgb === null) continue
    resolved.set(role.name, rgb)
    root.style.setProperty(role.name, toTriplet(rgb))
  }
  for (const role of DERIVED_ROLES) {
    const from = resolved.get(role.from)
    const to = resolved.get(role.to)
    if (from === undefined || to === undefined) continue
    root.style.setProperty(role.name, toTriplet(mixRgb(from, to, role.weight)))
  }
}

/** Re-apply on every host theme change; returns the unsubscribe. */
export function bindThemeChange(source: ThemeChangeSource, onChange: () => void): () => void {
  const handler = (): void => onChange()
  source.addEventListener('message', handler)
  return () => source.removeEventListener('message', handler)
}
