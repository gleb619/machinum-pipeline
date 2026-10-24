import type { Logger, RetryPolicy, ToolContext } from '@mt/core'

export type LlmProvider = 'router' | 'openrouter' | 'openai' | 'ollama' | 'anthropic' | 'custom'

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
}

export interface ResolvedLlmConfig {
  provider: LlmProvider
  model: string
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
  }
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
    case 'openai':
      return splitList(env.OPENAI_API_KEY)
    case 'anthropic':
      return splitList(env.ANTHROPIC_API_KEY)
    default:
      return []
  }
}

/**
 * Pure LLM config resolution. Precedence per field (first defined wins):
 *
 *   input > tool > meta.llm > mt.json settings (`llm.*`) > env > defaults
 *
 * Extras: `baseUrl` for provider `router` falls back to ctx `routerUrl`, `MT_ROUTER_URL`, then
 * `http://localhost:7777`; `retry` falls back to ctx `defaults.retry`; API keys never come from `meta`.
 * Provider is never inferred from available keys: unset means `router` (legacy behaviour).
 */
export function resolveLlmConfig(args: ResolveLlmConfigArgs = {}): ResolvedLlmConfig {
  const env = args.env ?? {}
  const layers: Array<[string, LlmConfigLayer]> = [
    ['input', args.input ?? {}],
    ['tool', args.tool ?? {}],
    ['meta', metaLayer(args.meta)],
    ['settings', settingsLayer(args.settings)],
    ['env', envLayer(env)],
  ]
  for (const [, l] of layers) l.provider = parseProvider(l.provider, 'config')
  const sources: Record<string, string> = {}

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

  const provider = orDefault<LlmProvider>('provider', pick('provider'), 'router')
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

  return {
    provider,
    model,
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
    projectRoot: g?.project?.root ?? process.cwd(),
    logger: ctx?.run?.logger,
  }
}

/** Resolve config for a tool invocation straight from ctx + envelope meta. */
export function resolveLlmConfigFromCtx(
  ctx: ToolContext | undefined,
  parts: { input?: LlmConfigLayer; tool?: LlmConfigLayer; meta?: Record<string, unknown> } = {},
): ResolvedLlmConfig {
  const v = readCtx(ctx)
  return resolveLlmConfig({
    ...parts,
    settings: v.settings,
    routerUrl: v.routerUrl,
    retryDefault: v.retry,
    env: v.env,
  })
}
