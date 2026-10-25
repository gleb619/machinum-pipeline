import { DEFAULT_UPSTREAM, type Upstream, type UpstreamRegistry } from './upstream.js'

/**
 * Routable model ids for `GET /api/models` (OpenAI list shape). Default upstream models keep their
 * bare OpenRouter id; other upstreams are `<upstream>/<model>`, from the configured `models` plus a
 * cheap live listing (`<baseUrl>/models`, ollama `/api/tags`) cached for a minute. Live failures
 * are non-fatal and never surface keys or upstream bodies.
 */

export interface ModelEntry {
  id: string
  object: 'model'
  owned_by: string
}

/** Alias that always routes to OpenRouter's free pool. */
export const FREE_ALIAS = 'openrouter/free'

const CACHE_TTL_MS = 60_000
const LIVE_TIMEOUT_MS = 2_000
const cache = new Map<string, { at: number; ids: string[] }>()

export function clearModelsCache(): void {
  cache.clear()
}

async function fetchLive(up: Upstream): Promise<string[]> {
  const cacheKey = `${up.name}|${up.baseUrl}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ids
  let ids: string[] = []
  try {
    const headers: Record<string, string> = { ...up.headers }
    const key = up.getPool().getAvailableClient()?.apiKey
    if (key) headers.Authorization = `Bearer ${key}`
    const url =
      up.kind === 'ollama' ? `${up.baseUrl.replace(/\/v1$/, '')}/api/tags` : `${up.baseUrl}/models`
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) })
    if (res.ok) {
      const body = (await res.json()) as {
        data?: Array<{ id?: unknown }>
        models?: Array<{ name?: unknown; model?: unknown }>
      }
      const raw =
        up.kind === 'ollama'
          ? (body.models ?? []).map((m) => m.name ?? m.model)
          : (body.data ?? []).map((m) => m.id)
      ids = raw.filter((x): x is string => typeof x === 'string' && x !== '')
    }
  } catch {
    // unreachable / bad JSON: fall back to configured models only
  }
  cache.set(cacheKey, { at: Date.now(), ids })
  return ids
}

export async function listModels(registry: UpstreamRegistry): Promise<ModelEntry[]> {
  const out = new Map<string, ModelEntry>()
  const add = (id: string, owner: string) => {
    if (!out.has(id)) out.set(id, { id, object: 'model', owned_by: owner })
  }
  const def = registry.defaultUpstream
  add(FREE_ALIAS, DEFAULT_UPSTREAM)
  for (const m of def.models) add(m, DEFAULT_UPSTREAM)
  const others = registry.list().filter((u) => u.name !== DEFAULT_UPSTREAM)
  const live = await Promise.all(others.map((u) => fetchLive(u)))
  others.forEach((u, i) => {
    const ids = [...u.models, ...(live[i] ?? [])]
    for (const m of ids) add(m.startsWith(`${u.name}/`) ? m : `${u.name}/${m}`, u.name)
  })
  return [...out.values()]
}
