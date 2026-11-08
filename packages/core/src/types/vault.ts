import type { VaultProvider } from '../vault.js'
export interface LoadVaultOptions {
  /**
   * Resolve secret refs (`vlt:`, `keepass:`, `embed:`) in `apiKey`/`apiKeys` (default true).
   * Pass false when only the stored values matter (e.g. editing the file).
   */
  resolveRefs?: boolean
  /** @deprecated use {@link resolveRefs}. */
  resolveVlt?: boolean
}

export interface ResolvedVaultRef {
  entry: VaultEntry
  name: string
  model: string | undefined
}

export interface VaultRef {
  entry: string
  model?: string
}

export interface Vault {
  version: 1
  entries: Record<string, VaultEntry>
}

export interface VaultEntry {
  provider: VaultProvider
  baseUrl?: string
  apiKey?: string
  apiKeys?: string[]
  headers?: Record<string, string>
  models?: string[]
  defaultModel?: string
  notes?: string
}
