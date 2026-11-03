export const TUI_NAME = '@mt/tui'

export interface TuiOptions {
  /** Base URL of `mt serve`, e.g. `http://localhost:3000` */
  baseUrl: string
}

export async function pingServer({ baseUrl }: TuiOptions): Promise<boolean> {
  const res = await fetch(new URL('/api/health', baseUrl))
  return res.ok
}
