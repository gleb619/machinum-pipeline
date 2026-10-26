import { resetKeepassState } from './keepass.js'
import { getRouterConfig } from './router-config.js'
import type { UpstreamSpec } from './upstream-spec.js'
import {
  type VaultEntry,
  readVaultEntries,
  readVaultEntriesAsync,
  vaultHasKeepassRefs,
  vaultPaths,
  vaultSignature,
} from './vault-reader.js'

/**
 * Maps vault entries to router upstreams, with a throttled mtime check so edits to the vault file
 * are picked up without a restart. Only entry names and counts ever reach logs; key values and file
 * content never do.
 *
 * `vlt:` refs resolve synchronously (see `vault-reader.ts`). `keepass:` refs need an async
 * kdbxweb load: a changed vault holding them triggers a background refresh and the previous good
 * result keeps serving until it completes. `startRouter()` awaits the first refresh.
 */

export interface VaultUpstreams {
  /** Keys from `openrouter` entries; feed the default upstream pool (after env keys). */
  openRouterKeys: string[]
  specs: UpstreamSpec[]
  /** Names of the entries that became upstreams or feed the default pool. */
  names: string[]
}

const EMPTY: VaultUpstreams = { openRouterKeys: [], specs: [], names: [] }

function entryKeys(entry: VaultEntry): string[] {
  return [...(entry.apiKey ? [entry.apiKey] : []), ...(entry.apiKeys ?? [])]
    .map((k) => k.trim())
    .filter(Boolean)
}

export function mapVaultEntries(
  entries: Record<string, VaultEntry>,
  warn: (msg: string) => void = () => {},
): VaultUpstreams {
  const result: VaultUpstreams = { openRouterKeys: [], specs: [], names: [] }
  for (const [name, entry] of Object.entries(entries)) {
    const keys = entryKeys(entry)
    switch (entry.provider) {
      case 'openrouter':
        result.openRouterKeys.push(...keys)
        result.names.push(name)
        break
      case 'ollama':
      case 'openai':
      case 'custom': {
        if (name === 'openrouter') {
          warn(`vault entry "${name}" skipped: name is reserved for the default upstream`)
          break
        }
        const kind = entry.provider === 'ollama' ? 'ollama' : 'openai-compat'
        const baseUrl = entry.baseUrl?.trim() || (kind === 'ollama' ? 'http://localhost:11434' : '')
        if (!baseUrl) {
          warn(`vault entry "${name}" skipped: provider "${entry.provider}" needs a baseUrl`)
          break
        }
        result.specs.push({
          name,
          kind,
          baseUrl,
          keys,
          headers: entry.headers,
          models: entry.models,
          defaultModel: entry.defaultModel,
        })
        result.names.push(name)
        break
      }
      case 'router':
        break
      default:
        warn(`vault entry "${name}" skipped: provider "${entry.provider}" is not supported`)
    }
  }
  return result
}

let current: VaultUpstreams = EMPTY
let lastSignature: string | undefined
let lastCheck = 0
let lastVersion = 0
let generation = 0
let refreshing: Promise<void> | undefined

function pollMs(): number {
  const raw = process.env.MT_ROUTER_VAULT_POLL_MS
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isNaN(parsed) ? 2000 : parsed
}

function swap(mapped: VaultUpstreams, first: boolean): void {
  current = mapped
  lastVersion++
  if (!first || mapped.names.length > 0) {
    console.error(`[router] vault loaded: ${mapped.names.length} entries`)
  }
}

function logFailure(err: unknown, first: boolean): void {
  const msg = err instanceof Error ? err.message : 'unreadable'
  console.error(`[router] vault ignored${first ? '' : ' (keeping previous entries)'}: ${msg}`)
  if (first) current = EMPTY
}

/**
 * Re-read the vault asynchronously (keepass refs included) and swap the cached result.
 * Concurrent callers share one refresh. Used by `startRouter()` and by the sync getter
 * when a keepass ref appears.
 */
export function refreshVaultUpstreams(): Promise<void> {
  if (refreshing) return refreshing
  const runGeneration = generation
  refreshing = (async () => {
    lastCheck = Date.now()
    const paths = vaultPaths()
    const signature = vaultSignature(paths)
    if (signature === lastSignature) return
    const first = lastSignature === undefined
    lastSignature = signature
    try {
      const mapped = mapVaultEntries(await readVaultEntriesAsync(paths), (m) =>
        console.error(`[router] ${m}`),
      )
      if (runGeneration === generation) swap(mapped, first)
    } catch (err) {
      if (runGeneration === generation) logFailure(err, first)
    }
  })().finally(() => {
    refreshing = undefined
  })
  return refreshing
}

/**
 * Current vault-derived upstreams. Re-stats the vault file(s) at most every poll interval (default
 * 2s); on change re-reads and swaps the result. Vaults with `keepass:` refs refresh in the
 * background; the previous result is served until the async load completes.
 */
export function getVaultUpstreams(): VaultUpstreams {
  const now = Date.now()
  if (lastSignature !== undefined && now - lastCheck < pollMs()) return current
  lastCheck = now
  const paths = vaultPaths()
  const signature = vaultSignature(paths)
  if (signature === lastSignature) return current
  try {
    if (vaultHasKeepassRefs(paths)) {
      void refreshVaultUpstreams()
      return current
    }
  } catch (err) {
    logFailure(err, lastSignature === undefined)
    return current
  }
  const first = lastSignature === undefined
  lastSignature = signature
  try {
    swap(
      mapVaultEntries(readVaultEntries(paths), (m) => console.error(`[router] ${m}`)),
      first,
    )
  } catch (err) {
    logFailure(err, first)
  }
  return current
}

/** Incremented on every successful (re)load; lets callers cache derived structures. */
export function vaultVersion(): number {
  return lastVersion
}

/** Forget cached state (tests, config reset). */
export function resetVaultState(): void {
  generation++
  current = EMPTY
  lastSignature = undefined
  lastCheck = 0
  refreshing = undefined
  resetKeepassState()
}

/** Default-upstream keys: config/env keys first, then vault `openrouter` keys; deduplicated. */
export function effectiveApiKeys(): string[] {
  const config = getRouterConfig()
  if (!config.vault) return config.apiKeys
  return [...new Set([...config.apiKeys, ...getVaultUpstreams().openRouterKeys])]
}

/** Extra upstreams: config/env specs win over vault entries of the same name. */
export function effectiveUpstreamSpecs(): UpstreamSpec[] {
  const config = getRouterConfig()
  if (!config.vault) return config.upstreams
  const taken = new Set(config.upstreams.map((s) => s.name))
  return [...config.upstreams, ...getVaultUpstreams().specs.filter((s) => !taken.has(s.name))]
}
