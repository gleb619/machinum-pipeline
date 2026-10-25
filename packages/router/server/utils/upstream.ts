import { poolSupplier as openRouterSupplier } from './openrouter-pool-supplier.js'
import { type OpenRouterPool, OpenRouterPoolSupplier } from './openrouter-pool.js'
import type { UpstreamKind, UpstreamSpec } from './upstream-spec.js'
import { effectiveApiKeys, effectiveUpstreamSpecs } from './vault-upstreams.js'

export type { UpstreamKind, UpstreamSpec } from './upstream-spec.js'
export { upstreamSpecsFromEnv } from './upstream-spec.js'

/**
 * Upstream registry: the set of OpenAI-compatible backends the router can forward to, and the model
 * routing rule that picks one. The registry is derived from the effective router config (env / code)
 * plus the vault (`vault-upstreams.ts`), and is swapped atomically when either changes.
 */

export const DEFAULT_UPSTREAM = 'openrouter'
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export interface Upstream {
  name: string
  kind: UpstreamKind
  baseUrl: string
  keyless: boolean
  headers: Record<string, string>
  models: string[]
  defaultModel?: string
  getPool(): OpenRouterPool
}

export interface ResolvedModel {
  upstream: Upstream
  /** Model id as the upstream expects it (routing prefix stripped). */
  upstreamModel: string
}

function normalizeBaseUrl(kind: UpstreamKind, raw: string): string {
  const url = raw.trim().replace(/\/+$/, '')
  // Ollama serves its OpenAI-compatible API under /v1.
  return kind === 'ollama' && !/\/v1$/.test(url) ? `${url}/v1` : url
}

export class UpstreamRegistry {
  private readonly upstreams = new Map<string, Upstream>()

  register(spec: UpstreamSpec): Upstream {
    if (spec.name === DEFAULT_UPSTREAM) {
      throw new Error(`upstream name '${DEFAULT_UPSTREAM}' is reserved for the default upstream`)
    }
    return this.add(spec, undefined)
  }

  /** Registers the default upstream; reuses the shared OpenRouter pool singleton when given. */
  registerDefault(spec: UpstreamSpec, supplier?: { getPool(): OpenRouterPool }): Upstream {
    return this.add({ ...spec, name: DEFAULT_UPSTREAM }, supplier)
  }

  private add(spec: UpstreamSpec, shared: { getPool(): OpenRouterPool } | undefined): Upstream {
    const baseUrl = normalizeBaseUrl(spec.kind, spec.baseUrl)
    const keys = (spec.keys ?? []).map((k) => k.trim()).filter(Boolean)
    const keyless = keys.length === 0
    const supplier =
      shared ??
      new OpenRouterPoolSupplier({
        // A keyless upstream still needs one pool slot so it can be round-robined and blocked.
        clients: (keyless ? [''] : keys).map((apiKey) => ({ apiKey, apiUrl: baseUrl })),
      })
    const upstream: Upstream = {
      name: spec.name,
      kind: spec.kind,
      baseUrl,
      keyless,
      headers: spec.headers ?? {},
      models: spec.models ?? [],
      defaultModel: spec.defaultModel,
      getPool: () => supplier.getPool(),
    }
    this.upstreams.set(spec.name, upstream)
    return upstream
  }

  /** Re-registers an existing upstream as is, keeping its pool state. */
  adopt(upstream: Upstream): void {
    this.upstreams.set(upstream.name, upstream)
  }

  get(name: string): Upstream | undefined {
    return this.upstreams.get(name)
  }

  list(): Upstream[] {
    return [...this.upstreams.values()]
  }

  get defaultUpstream(): Upstream {
    const found = this.upstreams.get(DEFAULT_UPSTREAM)
    if (!found) throw new Error('default upstream missing')
    return found
  }

  /**
   * `<name>/<model>` routes to a registered non-default upstream and strips the prefix. Anything
   * else (bare ids, `openrouter/free`, `openrouter/auto`, unknown prefixes) goes to the default
   * upstream untouched, because those are real OpenRouter model ids.
   */
  resolve(model: string): ResolvedModel {
    const slash = model.indexOf('/')
    if (slash > 0) {
      const named = this.upstreams.get(model.slice(0, slash))
      if (named && named.name !== DEFAULT_UPSTREAM) {
        return { upstream: named, upstreamModel: model.slice(slash + 1) }
      }
    }
    return { upstream: this.defaultUpstream, upstreamModel: model }
  }
}

export function buildRegistry(
  apiKeys: string[],
  specs: UpstreamSpec[],
  openRouterPool?: { getPool(): OpenRouterPool },
): UpstreamRegistry {
  const registry = new UpstreamRegistry()
  registry.registerDefault(
    { name: DEFAULT_UPSTREAM, kind: 'openrouter', baseUrl: OPENROUTER_BASE_URL, keys: apiKeys },
    openRouterPool,
  )
  for (const spec of specs) {
    if (spec.name === DEFAULT_UPSTREAM) continue
    registry.register(spec)
  }
  return registry
}

let registry: UpstreamRegistry | undefined
let registrySignature = ''
const specSignatures = new Map<string, string>()

/**
 * Registry for the effective config (env + code + vault); rebuilt only when keys or upstream specs
 * change. Upstreams whose spec is unchanged are carried over so their pool state (rate-limit blocks,
 * disabled keys) survives a reload; the swap is a single assignment.
 */
export function getUpstreamRegistry(): UpstreamRegistry {
  const apiKeys = effectiveApiKeys()
  const specs = effectiveUpstreamSpecs()
  const signature = JSON.stringify([apiKeys, specs])
  if (registry && signature === registrySignature) return registry
  const next = buildRegistry(apiKeys, [], openRouterSupplier)
  const nextSignatures = new Map<string, string>()
  for (const spec of specs) {
    if (spec.name === DEFAULT_UPSTREAM) continue
    const sig = JSON.stringify(spec)
    nextSignatures.set(spec.name, sig)
    const previous = registry?.get(spec.name)
    if (previous && specSignatures.get(spec.name) === sig) next.adopt(previous)
    else next.register(spec)
  }
  specSignatures.clear()
  for (const [k, v] of nextSignatures) specSignatures.set(k, v)
  registry = next
  registrySignature = signature
  return registry
}
