/** Upstream config shapes + env parsing. No router-config import, so config can depend on it. */

export type UpstreamKind = 'openrouter' | 'ollama' | 'openai-compat'

export interface UpstreamSpec {
  name: string
  kind: UpstreamKind
  baseUrl: string
  /** Empty or missing means a keyless upstream: no Authorization header is sent. */
  keys?: string[]
  headers?: Record<string, string>
  models?: string[]
  defaultModel?: string
}

const KINDS: readonly string[] = ['openrouter', 'ollama', 'openai-compat']

/** Parses `MT_ROUTER_UPSTREAMS` (JSON array) and `MT_ROUTER_OLLAMA_URL`. Invalid entries are skipped. */
export function upstreamSpecsFromEnv(env: NodeJS.ProcessEnv = process.env): UpstreamSpec[] {
  const specs: UpstreamSpec[] = []
  const raw = env.MT_ROUTER_UPSTREAMS
  if (raw?.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue
          const e = item as Record<string, unknown>
          if (typeof e.name !== 'string' || !e.name || e.name.includes('/')) continue
          if (typeof e.kind !== 'string' || !KINDS.includes(e.kind)) continue
          if (typeof e.baseUrl !== 'string' || !e.baseUrl) continue
          specs.push({
            name: e.name,
            kind: e.kind as UpstreamKind,
            baseUrl: e.baseUrl,
            keys: Array.isArray(e.keys) ? e.keys.filter((k) => typeof k === 'string') : undefined,
            headers:
              e.headers && typeof e.headers === 'object'
                ? (e.headers as Record<string, string>)
                : undefined,
            models: Array.isArray(e.models)
              ? e.models.filter((m) => typeof m === 'string')
              : undefined,
            defaultModel: typeof e.defaultModel === 'string' ? e.defaultModel : undefined,
          })
        }
      }
    } catch {
      console.error('[router] MT_ROUTER_UPSTREAMS is not valid JSON; ignored')
    }
  }
  const ollama = env.MT_ROUTER_OLLAMA_URL?.trim()
  if (ollama && !specs.some((s) => s.name === 'ollama')) {
    specs.push({ name: 'ollama', kind: 'ollama', baseUrl: ollama })
  }
  return specs
}
