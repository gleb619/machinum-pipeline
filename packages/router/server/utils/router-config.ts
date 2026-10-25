import { join } from 'node:path'
import { type UpstreamSpec, upstreamSpecsFromEnv } from './upstream-spec.js'

/**
 * Router settings, resolved once from explicit overrides + environment.
 *
 * Under Nitro (`pnpm dev --filter=@mt/router`) the values come from the environment only;
 * `startRouter()` — which is `mt router`, and therefore the single-file Bun binary — passes CLI flags
 * in explicitly, and those win. Nitro's `useRuntimeConfig()` deliberately has no equivalent here: the
 * standalone runtime must not depend on a build-time injected config.
 */
export interface RouterConfig {
  port: number
  host: string
  mock: boolean
  logDir: string
  dailyBudget: number
  retentionDays: number
  /** OpenRouter keys backing the pool; empty means "no key configured". */
  apiKeys: string[]
  /** Extra upstreams (ollama, openai-compat, ...) besides the default OpenRouter one. */
  upstreams: UpstreamSpec[]
}

export type RouterConfigInput = Partial<RouterConfig>

function defaultLogDir(): string {
  const mtHome = process.env.MT_HOME || join(process.env.HOME || '/root', '.mt')
  return join(mtHome, 'router')
}

function envKeys(): string[] {
  return (process.env.OPENROUTER_API_KEYS ?? process.env.OPENROUTER_API_KEY ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
}

function numberFrom(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseFloat(raw)
  return Number.isNaN(parsed) ? fallback : parsed
}

function fromEnv(): RouterConfig {
  return {
    port: numberFrom(process.env.PORT ?? process.env.MT_ROUTER_PORT, 7777),
    host: process.env.MT_ROUTER_HOST || 'localhost',
    mock: process.env.MT_ROUTER_MOCK === 'true',
    logDir: defaultLogDir(),
    dailyBudget: numberFrom(process.env.MT_DAILY_BUDGET, 5),
    retentionDays: numberFrom(process.env.MT_RETENTION_DAYS, 30),
    apiKeys: envKeys(),
    upstreams: upstreamSpecsFromEnv(),
  }
}

let config = fromEnv()

/** Current effective config. Never undefined: the environment alone is a valid configuration. */
export function getRouterConfig(): RouterConfig {
  return config
}

/**
 * Replace the effective config before the first request (called by `startRouter()`). Omitted fields
 * fall back to the environment, so a partial override never leaks a stale value.
 */
export function setRouterConfig(input: RouterConfigInput = {}): RouterConfig {
  const base = fromEnv()
  config = {
    port: input.port ?? base.port,
    host: input.host ?? base.host,
    mock: input.mock ?? base.mock,
    logDir: input.logDir ?? base.logDir,
    dailyBudget: input.dailyBudget ?? base.dailyBudget,
    retentionDays: input.retentionDays ?? base.retentionDays,
    apiKeys: input.apiKeys ?? base.apiKeys,
    upstreams: input.upstreams ?? base.upstreams,
  }
  return config
}
