import { DEFAULT_ROUTER_URL } from './llm-config.js'

/** Model alias that always routes to OpenRouter's free pool through the router. */
export const ROUTER_FREE_MODEL = 'openrouter/free'

/** One entry of the router's `GET /api/models`. */
export interface RouterModelInfo {
  /** Routable id: bare OpenRouter id, or `<upstream>/<model>`. */
  id: string
  ownedBy?: string
}

export interface RouterModelsOptions {
  /** Optional router token (`MT_ROUTER_TOKEN`); sent as a bearer header only when set. */
  token?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

/**
 * Models the router can route (`GET <baseUrl>/api/models`). Throws when the router is unreachable
 * or answers non-2xx; the message never includes the token.
 */
export async function listRouterModels(
  baseUrl: string = DEFAULT_ROUTER_URL,
  options: RouterModelsOptions = {},
): Promise<RouterModelInfo[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/models`
  const fetchImpl = options.fetch ?? globalThis.fetch
  const headers: Record<string, string> = {}
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  const res = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  })
  if (!res.ok) throw new Error(`router request failed: ${res.status} (${url})`)
  const data = (await res.json()) as { data?: Array<{ id?: unknown; owned_by?: unknown }> }
  return (data?.data ?? [])
    .filter((m): m is { id: string; owned_by?: unknown } => typeof m.id === 'string' && m.id !== '')
    .map((m) => ({
      id: m.id,
      ...(typeof m.owned_by === 'string' ? { ownedBy: m.owned_by } : {}),
    }))
}
