/**
 * Terminal skin of the shared state contract (docs/steering/colors.md §7).
 * Widgets never embed raw escapes: they ask for a state's SGR code and wrap text here.
 */

export type StateName = 'running' | 'paused' | 'done' | 'failed' | 'pending'

const STATE_ANSI: Readonly<Record<StateName, string>> = {
  running: '92',
  paused: '93',
  done: '96',
  failed: '91',
  pending: '90',
}

const DEFAULT_STATE: StateName = 'pending'

/** SGR parameters for a state; unknown states are dim (`90`). */
export function stateAnsi(state: string): string {
  const key = state.trim().toLowerCase() as StateName
  return STATE_ANSI[key] ?? STATE_ANSI[DEFAULT_STATE]
}

/** Uppercase label — state is never conveyed by colour alone. */
export function stateLabel(state: string): string {
  return state.trim().toUpperCase()
}

/** `NO_COLOR` (non-empty) or a dumb terminal disables SGR output. */
export function detectNoColor(env: Record<string, string | undefined> = process.env): boolean {
  return (env.NO_COLOR !== undefined && env.NO_COLOR !== '') || env.TERM === 'dumb'
}

/** Wrap `text` in an SGR code, or return it untouched when colour is off. */
export function colorize(text: string, ansi: string, color = true): string {
  if (!color || ansi === '') return text
  return `\u001b[${ansi}m${text}\u001b[0m`
}
