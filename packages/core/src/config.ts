import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ErrorPolicy, GlobalContext, RetryPolicy, RetryStrategy } from './contexts.js'
import type { Settings } from './settings.js'
import { loadVault } from './vault.js'

/**
 * Lifecycle hook scripts declared in `mt.json` under `scripts`.
 * Each value is a path to a pipeline module file (relative to the project root)
 * executed at that lifecycle moment:
 * - `install` — run by `mt install` (one-time project setup, e.g. generating config files)
 * - `start` — run by `mt run` before the main pipeline starts
 * - `end` — run by `mt run` after the main pipeline finishes (success or failure)
 */
export type LifecycleScripts = Partial<Record<'install' | 'start' | 'end', string>>

/**
 * mt.json project configuration shape.
 */
export interface MtConfig {
  project: {
    name: string
  }
  book?: {
    name?: string
    author?: string
    year?: number
  }
  storage?: {
    root?: string
  }
  secrets?: {
    envFile?: string
  }
  router?: {
    port?: number
  }
  model?: {
    default?: string
  }
  defaults?: {
    retry?: {
      max?: number
      backoffMs?: number
      strategy?: 'fixed' | 'linear' | 'exp'
      maxBackoffMs?: number
    }
    onError?: 'fail-run' | 'skip-item' | 'dead-letter'
    concurrency?: number
  }
  settings?: Settings
  /** Named URI aliases (e.g. `{ "en": "md://./chapters/en" }`), surfaced as `settings.uris` */
  uris?: Record<string, string>
  pipelines?: string[]
  /** Lifecycle hook pipeline modules (see {@link LifecycleScripts}). */
  scripts?: LifecycleScripts
}

export const DEFAULT_MT_CONFIG = {
  project: {
    name: 'my-book-project',
  },
  book: {
    name: 'My Book',
  },
  storage: {
    root: '.mt',
  },
  secrets: {
    envFile: '.env',
  },
  router: {
    port: 7777,
  },
  defaults: {
    retry: {
      max: 3,
      backoffMs: 1000,
      strategy: 'exp',
    },
    onError: 'fail-run',
    concurrency: 4,
  },
  pipelines: ['./pipelines/example.ts'],
} satisfies MtConfig

/**
 * Parse a `.env`-style file into key/value pairs.
 * Accepts an `export ` prefix, single/double quoted values, `#` comment lines,
 * and trailing ` #` comments on unquoted values.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const entry = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const key = entry.slice(0, separator).trim()
    if (key === '') continue
    env[key] = unwrapEnvValue(entry.slice(separator + 1).trim())
  }
  return env
}

function unwrapEnvValue(value: string): string {
  const quote = value.charAt(0)
  if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
    return value.slice(1, -1)
  }
  const comment = value.indexOf(' #')
  return comment === -1 ? value : value.slice(0, comment).trim()
}

/**
 * Build the project's GlobalContext from `mt.json`, the single source of truth
 * shared by the CLI (`mt run` / `mt resume`) and the admin start route.
 *
 * Missing `mt.json` falls back to `DEFAULT_MT_CONFIG`; a malformed one throws.
 * `secrets.envFile` is read into `env` and never overrides a value already set
 * in `process.env`, nor writes back into it.
 */
export async function loadGlobalContext(projectRoot: string): Promise<GlobalContext> {
  const config = await readMtConfig(projectRoot)
  const settings: Settings = { ...config.settings }
  if (config.uris) settings.uris = config.uris

  const env = await loadEnv(
    projectRoot,
    config.secrets?.envFile ?? DEFAULT_MT_CONFIG.secrets.envFile,
  )
  const ctx: GlobalContext = {
    project: {
      name: config.project?.name ?? DEFAULT_MT_CONFIG.project.name,
      root: projectRoot,
    },
    defaults: {
      retry: resolveRetry(config.defaults?.retry),
      onError: config.defaults?.onError ?? DEFAULT_MT_CONFIG.defaults.onError,
      concurrency: config.defaults?.concurrency ?? DEFAULT_MT_CONFIG.defaults.concurrency,
    },
    settings,
    env,
  }
  // Non-enumerable: keeps secrets out of JSON.stringify, spreads, checkpoints and logs.
  Object.defineProperty(ctx, 'vault', {
    value: await loadVault(projectRoot, process.env),
    enumerable: false,
    writable: true,
    configurable: true,
  })
  return ctx
}

type PartialRetry = {
  max?: number
  backoffMs?: number
  strategy?: RetryStrategy
  maxBackoffMs?: number
}

function resolveRetry(retry: PartialRetry | undefined): RetryPolicy {
  const fallback = DEFAULT_MT_CONFIG.defaults.retry
  const policy: RetryPolicy = {
    max: retry?.max ?? fallback.max,
    backoffMs: retry?.backoffMs ?? fallback.backoffMs,
    strategy: retry?.strategy ?? fallback.strategy,
  }
  // Unset stays unset: withRetry then applies DEFAULT_MAX_BACKOFF_MS.
  const maxBackoffMs = retry?.maxBackoffMs
  if (maxBackoffMs !== undefined) policy.maxBackoffMs = maxBackoffMs
  return policy
}

/**
 * Read and parse `mt.json` at `projectRoot` (no merging over defaults).
 * Missing file yields `{}`; a malformed one throws naming the file path.
 * Used by lifecycle hooks (`scripts.*`) which need the raw config, not a `GlobalContext`.
 */
export async function readMtConfig(projectRoot: string): Promise<Partial<MtConfig>> {
  const configPath = resolve(projectRoot, 'mt.json')
  let raw: string
  try {
    raw = await readFile(configPath, 'utf-8')
  } catch (err) {
    if (isNotFound(err)) return {}
    throw new Error(`Cannot read mt.json at ${configPath}: ${errorMessage(err)}`)
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object')
    }
    return parsed as Partial<MtConfig>
  } catch (err) {
    throw new Error(`Invalid mt.json at ${configPath}: ${errorMessage(err)}`)
  }
}

async function loadEnv(projectRoot: string, envFile: string): Promise<Record<string, string>> {
  const env = parseEnvFile(await readEnvFile(resolve(projectRoot, envFile)))
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

async function readEnvFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return ''
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err as { code?: string }).code === 'ENOENT'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
