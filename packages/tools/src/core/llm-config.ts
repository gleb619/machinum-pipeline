import { type Vault, resolveVaultRef } from '@mt/core'
import type { Logger, RetryPolicy, ToolContext } from '@mt/core'
import { defaultTransportKind } from './llm-sdk-transports.js'

export type LlmProvider = 'router' | 'openrouter' | 'openai' | 'ollama' | 'anthropic' | 'custom'

/** HTTP stack used to talk to the provider. `sdk` = official provider SDK (lazy-loaded), `fetch` = built-in HTTP adapters. */
export type LlmTransportKind = 'sdk' | 'fetch'

export const LLM_PROVIDERS: readonly LlmProvider[] = [
  'router',
  'openrouter',
  'openai',
  'ollama',
  'anthropic',
  'custom',
]

/** One layer of LLM settings (call input, tool factory option, `meta.llm`, mt.json, ...). */
export interface LlmConfigLayer {
  provider?: LlmProvider
  model?: string
  baseUrl?: string
  apiKey?: string
  apiKeys?: string[]
  timeoutMs?: number
  retry?: Partial<RetryPolicy>
  cache?: boolean
  temperature?: number
  maxTokens?: number
  headers?: Record<string, string>
  transport?: LlmTransportKind
  /**
   * Vault ref (`vault://<entry>[/<model>]` | `@vault/<entry>[/<model>]`). Expanded from
   * `ctx.run.global.vault` into provider/baseUrl/keys/headers/model. Not a secret.
   */
  use?: string
}

export interface ResolvedLlmConfig {
  provider: LlmProvider
  model: string
  transport: LlmTransportKind
  baseUrl: string
  apiKey?: string
  apiKeys: string[]
  timeoutMs: number
  retry: RetryPolicy
  cache: boolean
  temperature?: number
  maxTokens?: number
  headers?: Record<string, string>
  /** Which layer supplied each field (observability; contains no secrets). */
  sources: Record<string, string>
}

export interface ResolveLlmConfigArgs {
  /** Per-call input layer (highest precedence). */
  input?: LlmConfigLayer
  /** Tool factory options. */
  tool?: LlmConfigLayer
  /** Envelope meta; reads `meta.llm`. `apiKey(s)` there are ignored (meta is checkpointed). */
  meta?: Record<string, unknown>
  /** `ctx.run.global.settings` (mt.json `settings`), keys `llm.<field>`. */
  settings?: Record<string, unknown>
  /** `ctx.run.global.routerUrl`. */
  routerUrl?: string
  /** `ctx.run.global.defaults.retry`. */
  retryDefault?: RetryPolicy
  /** Environment (pass `process.env` merged with `ctx.run.global.env`). */
  env?: Record<string, string | undefined>
  /**
   * Preset defaults (e.g. `createLlmGate({ llmDefaults })`): used when no layer above provides
   * the field. They sit above the generic `MT_LLM_*` env layer, so a preset pins its own
   * model/endpoint while a provider-specific env var (`MT_OLLAMA_URL`) still overrides it.
   * The provider is never read from this layer.
   */
  defaults?: LlmConfigLayer
  /** `ctx.run.global.vault`; required when any layer / `MT_LLM_USE` carries a vault ref. */
  vault?: Vault
}

export const DEFAULT_ROUTER_URL = 'http://localhost:7777'

export const DEFAULT_RETRY: RetryPolicy = { max: 3, backoffMs: 1000, strategy: 'exp' }
export const DEFAULT_TIMEOUT_MS = 120_000

const DEFAULT_MODEL: Record<LlmProvider, string> = {
  router: 'openai/gpt-4o-mini',
  openrouter: 'openai/gpt-4o-mini',
  openai: 'gpt-4o-mini',
  ollama: 'llama3.1',
  anthropic: 'claude-haiku-4-5',
  custom: 'openai/gpt-4o-mini',
}

const DEFAULT_BASE_URL: Partial<Record<LlmProvider, string>> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
  anthropic: 'https://api.anthropic.com',
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function posNum(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    if (/^(1|true|yes|on)$/i.test(v)) return true
    if (/^(0|false|no|off)$/i.test(v)) return false
  }
  return undefined
}

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseProvider(v: unknown, where: string): LlmProvider | undefined {
  const s = nonEmpty(v)
  if (!s) return undefined
  if ((LLM_PROVIDERS as readonly string[]).includes(s)) return s as LlmProvider
  throw new Error(`Unknown LLM provider '${s}' (from ${where}). Valid: ${LLM_PROVIDERS.join(', ')}`)
}

/** Layer from mt.json settings: flat keys `llm.provider`, `llm.model`, ... */
function settingsLayer(settings: Record<string, unknown> | undefined): LlmConfigLayer {
  const s = settings ?? {}
  const retryMax = posNum(s['llm.retry.max'])
  const retry = s['llm.retry'] as Partial<RetryPolicy> | undefined
  return {
    provider: parseProvider(s['llm.provider'], 'settings llm.provider'),
    model: nonEmpty(s['llm.model']),
    baseUrl: nonEmpty(s['llm.baseUrl']),
    apiKey: nonEmpty(s['llm.apiKey']),
    timeoutMs: posNum(s['llm.timeoutMs']),
    retry: retry ?? (retryMax !== undefined ? { max: retryMax } : undefined),
    cache: bool(s['llm.cache']),
    temperature: posNum(s['llm.temperature']),
    maxTokens: posNum(s['llm.maxTokens']),
    transport: parseTransport(s['llm.transport'], 'settings llm.transport'),
    use: nonEmpty(s['llm.use']),
  }
}

function metaLayer(meta: Record<string, unknown> | undefined): LlmConfigLayer {
  const m = meta?.llm
  if (!m || typeof m !== 'object') return {}
  const { apiKey: _k, apiKeys: _ks, ...rest } = m as LlmConfigLayer
  return { ...rest, provider: parseProvider(rest.provider, 'meta.llm.provider') }
}

function envLayer(env: Record<string, string | undefined>): LlmConfigLayer {
  return {
    provider: parseProvider(env.MT_LLM_PROVIDER, 'env MT_LLM_PROVIDER'),
    model: nonEmpty(env.MT_LLM_MODEL),
    baseUrl: nonEmpty(env.MT_LLM_BASE_URL),
    timeoutMs: posNum(env.MT_LLM_TIMEOUT_MS),
    cache: bool(env.MT_LLM_CACHE),
    transport: parseTransport(env.MT_LLM_TRANSPORT, 'env MT_LLM_TRANSPORT'),
  }
}

/**
 * Provider-specific env vars. They sit above the generic `MT_LLM_*` env layer and below the
 * per-call / tool / meta / settings layers, so a preset can pin a provider default (e.g. the
 * ollama endpoint) that the user still overrides with the dedicated env var.
 */
function providerEnvLayer(
  provider: LlmProvider,
  env: Record<string, string | undefined>,
): LlmConfigLayer {
  switch (provider) {
    case 'ollama':
      return {
        model: nonEmpty(env.MT_OLLAMA_MODEL),
        baseUrl: nonEmpty(env.MT_OLLAMA_URL),
      }
    default:
      return {}
  }
}

function parseTransport(v: unknown, where: string): LlmTransportKind | undefined {
  const s = nonEmpty(v)
  if (!s) return undefined
  if (s === 'sdk' || s === 'fetch') return s
  throw new Error(`Unknown LLM transport '${s}' (from ${where}). Valid: sdk, fetch`)
}

/** Provider-specific env keys. `MT_LLM_API_KEY` applies to any provider and wins. */
function envKeys(provider: LlmProvider, env: Record<string, string | undefined>): string[] {
  const generic = nonEmpty(env.MT_LLM_API_KEY)
  if (generic) return [generic]
  switch (provider) {
    case 'openrouter': {
      const pool = splitList(env.OPENROUTER_API_KEYS)
      if (pool.length > 0) return pool
      return splitList(env.OPENROUTER_API_KEY)
    }
    case 'router':
      // Keyless gateway: the only credential a client may present is the optional router token.
      return splitList(env.MT_ROUTER_TOKEN)
    case 'openai':
      return splitList(env.OPENAI_API_KEY)
    case 'anthropic':
      return splitList(env.ANTHROPIC_API_KEY)
    default:
      return []
  }
}

interface ExpandedVaultRef {
  ref: string
  name: string
  /** Layer the ref came from; the expansion sits directly below it. */
  after: string
  layer: LlmConfigLayer
}

/** Expand the first vault ref found (highest layer first). Errors never include secrets. */
function expandVaultRef(
  candidates: Array<[string, string | undefined]>,
  vault: Vault | undefined,
): ExpandedVaultRef | undefined {
  for (const [after, ref] of candidates) {
    if (!ref) continue
    if (!vault) {
      throw new Error(`Vault ref "${ref}" (${after}): no vault loaded in the run context`)
    }
    const r = resolveVaultRef(vault, ref)
    const e = r.entry
    const layer: LlmConfigLayer = { provider: e.provider }
    if (e.baseUrl) layer.baseUrl = e.baseUrl
    if (e.apiKeys?.length) layer.apiKeys = [...e.apiKeys]
    else if (e.apiKey) layer.apiKey = e.apiKey
    if (e.headers) layer.headers = { ...e.headers }
    if (r.model) layer.model = r.model
    return { ref, name: r.name, after, layer }
  }
  return undefined
}

/**
 * Pure LLM config resolution. Precedence per field (first defined wins):
 *
 *   input > tool > meta.llm > mt.json settings (`llm.*`) > vault ref (`use`) > provider env
 *     > preset defaults > env > defaults
 *
 * Vault ref (`use`: `vault://<entry>[/<model>]` | `@vault/<entry>[/<model>]`): taken from the first
 * layer that carries one (input > tool > meta.llm > settings `llm.use` > env `MT_LLM_USE`) and
 * expanded from `ctx.run.global.vault` into ONE layer (provider, baseUrl, apiKey(s), headers,
 * model = ref model ?? entry.defaultModel) placed directly below the layer that carried the ref
 * (settings and env `MT_LLM_USE` -> directly below mt.json settings). So explicit fields of the
 * carrying layer and every higher layer beat the vault; vault beats provider env, preset defaults
 * and generic env. A higher layer pinning a different provider (e.g. the `ollamaTool` preset vs a
 * vault `openrouter` entry) is an error naming the ref. Secrets never reach `sources`
 * (reported as `vault:<entry>`), meta, logs or errors; `meta.llm` apiKey(s) stay ignored.
 *
 * Extras: `baseUrl` for provider `router` falls back to ctx `routerUrl`, `MT_ROUTER_URL`, then
 * `http://localhost:7777`; `retry` falls back to ctx `defaults.retry`; API keys never come from `meta`.
 * Provider is never inferred from available keys: unset means `router` (legacy behaviour).
 */
export function resolveLlmConfig(args: ResolveLlmConfigArgs = {}): ResolvedLlmConfig {
  const env = args.env ?? {}
  const inputLayer = args.input ?? {}
  const toolLayer = args.tool ?? {}
  const metaL = metaLayer(args.meta)
  const settingsL = settingsLayer(args.settings)
  const envL = envLayer(env)
  for (const l of [inputLayer, toolLayer, metaL, settingsL, envL]) {
    l.provider = parseProvider(l.provider, 'config')
  }
  const sources: Record<string, string> = {}

  const vaultRef = expandVaultRef(
    [
      ['input', inputLayer.use],
      ['tool', toolLayer.use],
      ['meta', metaL.use],
      ['settings', settingsL.use ?? nonEmpty(env.MT_LLM_USE)],
    ],
    args.vault,
  )
  const withVault = (rest: Array<[string, LlmConfigLayer]>): Array<[string, LlmConfigLayer]> => {
    if (!vaultRef) return rest
    const out: Array<[string, LlmConfigLayer]> = []
    for (const l of rest) {
      out.push(l)
      if (l[0] === vaultRef.after) out.push([`vault:${vaultRef.name}`, vaultRef.layer])
    }
    return out
  }

  let layers: Array<[string, LlmConfigLayer]> = withVault([
    ['input', inputLayer],
    ['tool', toolLayer],
    ['meta', metaL],
    ['settings', settingsL],
    ['env', envL],
  ])

  function pick<K extends keyof LlmConfigLayer>(key: K): LlmConfigLayer[K] | undefined {
    for (const [name, layer] of layers) {
      const v = layer[key]
      if (v !== undefined && v !== '') {
        sources[key] = name
        return v
      }
    }
    return undefined
  }

  function orDefault<T>(key: string, found: T | undefined, fallback: T): T {
    if (found !== undefined) return found
    sources[key] = 'default'
    return fallback
  }

  // Provider first: the provider-specific env layer depends on it.
  const provider = orDefault<LlmProvider>('provider', pick('provider'), 'router')
  // Provider env (`MT_OLLAMA_*`) and preset defaults sit above the generic `MT_LLM_*` env layer:
  // a preset pins its own model/endpoint, the user overrides it with the provider env var.
  if (vaultRef?.layer.provider && vaultRef.layer.provider !== provider) {
    throw new Error(
      `Vault ref "${vaultRef.ref}": entry "${vaultRef.name}" has provider '${vaultRef.layer.provider}' ` +
        `but a higher-precedence layer (${sources.provider}) pins provider '${provider}'`,
    )
  }
  layers = withVault([
    ['input', inputLayer],
    ['tool', toolLayer],
    ['meta', metaL],
    ['settings', settingsL],
    ['provider-env', providerEnvLayer(provider, env)],
    ['preset-defaults', args.defaults ?? {}],
    ['env', envL],
  ])

  const model = orDefault('model', pick('model'), DEFAULT_MODEL[provider])

  let baseUrl = pick('baseUrl')
  if (!baseUrl) {
    if (provider === 'router') {
      const fromCtx = nonEmpty(args.routerUrl)
      const fromEnv = nonEmpty(env.MT_ROUTER_URL)
      baseUrl = fromCtx ?? fromEnv ?? DEFAULT_ROUTER_URL
      sources.baseUrl = fromCtx ? 'ctx.routerUrl' : fromEnv ? 'env' : 'default'
    } else {
      baseUrl = DEFAULT_BASE_URL[provider]
      sources.baseUrl = 'default'
    }
  }
  if (!baseUrl)
    throw new Error("LLM provider 'custom' requires a baseUrl (llm.baseUrl / MT_LLM_BASE_URL)")

  let apiKeys: string[] = []
  for (const [name, layer] of layers) {
    if (name === 'meta') continue
    const list = layer.apiKeys?.length ? layer.apiKeys : layer.apiKey ? [layer.apiKey] : []
    if (list.length > 0 && name !== 'env') {
      apiKeys = list
      sources.apiKey = name
      break
    }
  }
  if (apiKeys.length === 0) {
    apiKeys = envKeys(provider, env)
    if (apiKeys.length > 0) sources.apiKey = 'env'
  }
  const apiKey = apiKeys[0]

  const retryLayer = pick('retry')
  const base = args.retryDefault ?? DEFAULT_RETRY
  if (!retryLayer) sources.retry = args.retryDefault ? 'ctx.defaults.retry' : 'default'
  const retry: RetryPolicy = { ...base, ...(retryLayer ?? {}) } as RetryPolicy

  const timeoutMs = orDefault('timeoutMs', pick('timeoutMs'), DEFAULT_TIMEOUT_MS)
  const cache = orDefault('cache', pick('cache'), false)
  const transport = pick('transport') ?? defaultTransportKind(provider)
  if (!('transport' in sources)) sources.transport = 'default'

  return {
    provider,
    model,
    transport,
    baseUrl,
    apiKey,
    apiKeys,
    timeoutMs,
    retry,
    cache,
    temperature: pick('temperature'),
    maxTokens: pick('maxTokens'),
    headers: pick('headers'),
    sources,
  }
}

/** Copy safe for logging: credentials removed. */
export function redactLlmConfig(
  cfg: ResolvedLlmConfig,
): Omit<ResolvedLlmConfig, 'apiKey' | 'apiKeys'> & { apiKeys: number; hasApiKey: boolean } {
  const { apiKey, apiKeys, headers, ...rest } = cfg
  return {
    ...rest,
    headers: headers ? Object.fromEntries(Object.keys(headers).map((k) => [k, '***'])) : undefined,
    apiKeys: apiKeys.length,
    hasApiKey: Boolean(apiKey),
  }
}

// ---------------------------------------------------------------------------
// Context access (tolerates partial/empty ctx in tests)
// ---------------------------------------------------------------------------

export interface CtxView {
  settings: Record<string, unknown>
  env: Record<string, string | undefined>
  routerUrl?: string
  retry?: RetryPolicy
  vault?: Vault
  projectRoot: string
  logger?: Logger
}

/** Safe view over `ToolContext`; `env` = `process.env` overlaid by `global.env`. */
export function readCtx(ctx?: ToolContext): CtxView {
  const g = ctx?.run?.global
  return {
    settings: (g?.settings as Record<string, unknown> | undefined) ?? {},
    env: { ...process.env, ...(g?.env ?? {}) },
    routerUrl: g?.routerUrl,
    retry: g?.defaults?.retry,
    vault: g?.vault,
    projectRoot: g?.project?.root ?? process.cwd(),
    logger: ctx?.run?.logger,
  }
}

/** Resolve config for a tool invocation straight from ctx + envelope meta. */
export function resolveLlmConfigFromCtx(
  ctx: ToolContext | undefined,
  parts: {
    input?: LlmConfigLayer
    tool?: LlmConfigLayer
    defaults?: LlmConfigLayer
    meta?: Record<string, unknown>
  } = {},
): ResolvedLlmConfig {
  const v = readCtx(ctx)
  return resolveLlmConfig({
    ...parts,
    settings: v.settings,
    routerUrl: v.routerUrl,
    retryDefault: v.retry,
    env: v.env,
    vault: v.vault,
  })
}
