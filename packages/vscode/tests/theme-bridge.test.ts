import { describe, expect, it, vi } from 'vitest'
import {
  type ThemeChangeSource,
  type ThemeRoot,
  type ThemeVariableSource,
  applyVsCodeTheme,
  bindThemeChange,
  hexToTriplet,
} from '../src/theme-bridge'

function sourceFrom(values: Record<string, string>): ThemeVariableSource {
  return { getPropertyValue: (name) => values[name] ?? '' }
}

function rootStub(): ThemeRoot & { values: Record<string, string> } {
  const values: Record<string, string> = {}
  return {
    values,
    style: {
      setProperty: (name, value) => {
        values[name] = value
      },
    },
  }
}

const THEME: Record<string, string> = {
  '--vscode-editor-background': '#1e1e1e',
  '--vscode-sideBar-background': '#252526',
  '--vscode-editorWidget-background': '#2d2d30',
  '--vscode-panel-border': '#3c3c3c',
  '--vscode-editor-foreground': '#d4d4d4',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-disabledForeground': '#6f6f6f',
  '--vscode-textLink-foreground': '#4daafc',
  '--vscode-charts-green': '#89d185',
  '--vscode-charts-yellow': '#cca700',
  '--vscode-errorForeground': '#f14c4c',
}

describe('T301 - VS Code theme bridge', () => {
  it('parses 6-digit hex into a Tailwind triplet', () => {
    expect(hexToTriplet('#0b0e12')).toBe('11 14 18')
  })

  it('parses 3-digit hex, case-insensitively and with surrounding space', () => {
    expect(hexToTriplet('#FFF')).toBe('255 255 255')
    expect(hexToTriplet('  #aBc ')).toBe('170 187 204')
  })

  it('rejects non-hex input', () => {
    expect(hexToTriplet('')).toBeNull()
    expect(hexToTriplet('rgb(1, 2, 3)')).toBeNull()
    expect(hexToTriplet('#12345')).toBeNull()
  })

  it('writes every Folio ramp step the webview uses', () => {
    const root = rootStub()
    applyVsCodeTheme(root, sourceFrom(THEME))

    expect(root.values['--gray-50']).toBe('30 30 30')
    expect(root.values['--gray-100']).toBe('37 37 38')
    expect(root.values['--gray-200']).toBe('45 45 48')
    expect(root.values['--gray-300']).toBe('60 60 60')
    expect(root.values['--gray-500']).toBe('111 111 111')
    expect(root.values['--gray-600']).toBe('157 157 157')
    expect(root.values['--gray-900']).toBe('212 212 212')
    expect(root.values['--blue-400']).toBe('77 170 252')
    expect(root.values['--green-400']).toBe('137 209 133')
    expect(root.values['--yellow-400']).toBe('204 167 0')
    expect(root.values['--red-400']).toBe('241 76 76')
  })

  it('derives the steps VS Code has no variable for from foreground/background', () => {
    const root = rootStub()
    applyVsCodeTheme(root, sourceFrom(THEME))

    // 45% / 78% / 90% / 100% of the foreground over the background.
    expect(root.values['--gray-400']).toBe('112 112 112')
    expect(root.values['--gray-700']).toBe('172 172 172')
    expect(root.values['--gray-800']).toBe('194 194 194')
    expect(root.values['--gray-950']).toBe('212 212 212')
  })

  it('falls back to the next variable when the first is empty', () => {
    const root = rootStub()
    applyVsCodeTheme(root, sourceFrom({ ...THEME, '--vscode-panel-border': '' }))

    expect(root.values['--gray-300']).toBeUndefined()

    const withFallback = rootStub()
    applyVsCodeTheme(
      withFallback,
      sourceFrom({
        ...THEME,
        '--vscode-panel-border': '',
        '--vscode-editorGroup-border': '#444444',
      }),
    )
    expect(withFallback.values['--gray-300']).toBe('68 68 68')
  })

  it('leaves a role untouched when no source variable resolves', () => {
    const root = rootStub()
    const source = sourceFrom({ '--vscode-editor-background': '#000000' })
    applyVsCodeTheme(root, source)

    expect(root.values['--gray-50']).toBe('0 0 0')
    expect(root.values['--blue-400']).toBeUndefined()
    expect(root.values['--gray-950']).toBeUndefined()
  })

  it('re-applies on host theme change until unsubscribed', () => {
    const listeners = new Set<() => void>()
    const host: ThemeChangeSource = {
      addEventListener: (_type, handler) => listeners.add(handler),
      removeEventListener: (_type, handler) => listeners.delete(handler),
    }
    const root = rootStub()
    let theme = THEME
    const onChange = vi.fn(() => applyVsCodeTheme(root, sourceFrom(theme)))

    const unbind = bindThemeChange(host, onChange)
    expect(listeners.size).toBe(1)

    theme = { ...THEME, '--vscode-textLink-foreground': '#ffffff' }
    for (const listener of listeners) listener()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(root.values['--blue-400']).toBe('255 255 255')

    unbind()
    expect(listeners.size).toBe(0)
    for (const listener of listeners) listener()
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
