import type { SyncScopeOptions } from './scope.js'

/** One file in a sync manifest. `mtime` is epoch milliseconds and informational only. */
export interface SyncManifestEntry {
  path: string
  size: number
  sha256: string
  mtime: number
}

/** Reuse hashes when size + mtime are unchanged. The cache is per sync run, never persisted. */
export interface SyncHashCache {
  get(path: string, size: number, mtime: number): string | undefined
  set(path: string, size: number, mtime: number, sha256: string): void
  clear(): void
}

export interface BuildManifestOptions extends SyncScopeOptions {
  /**
   * Explicit file list (POSIX paths relative to `root`). When omitted the tree is walked
   * with the default sync scope exclusions.
   */
  files?: Iterable<string>
  hashCache?: SyncHashCache
  /** Allow `.mt/runs/**` entries for output manifests. */
  allowRunState?: boolean
}
