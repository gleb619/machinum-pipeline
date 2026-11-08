import type { LifecycleScripts, RemoteSyncMode } from '../config.js'
import type { Settings } from './settings.js'
/**
 * mt.json project configuration shape.
 */
export interface MtConfig {
  /**
   * Extra config files deep-merged over this one, in order (later wins, so a gitignored
   * `mt.local.json` overrides the committed values). Paths are relative to the importing file;
   * a missing file is skipped, a malformed one throws. Objects merge key by key, everything
   * else (arrays, scalars) is replaced.
   */
  imports?: string[]
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
  serve?: {
    /** Secret reference (`env:NAME`, `vlt:`, `keepass:`, `embed:`) for the admin API bearer token. */
    tokenRef?: string
  }
  remote?: RemoteConfig
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

/** `mt.json -> remote`: default sync peer for `mt remote sync` and future remote runs. */
export interface RemoteConfig {
  url?: string
  /** `env:NAME`, `vlt:`, `keepass:` or `embed:` reference to the bearer token. */
  tokenRef?: string
  /** Stable mirror id; defaults to `<project-slug>-<root-hash8>`. */
  projectId?: string
  sync?: RemoteSyncConfig
}

/** `mt.json -> remote.sync` scope and transfer limits. */
export interface RemoteSyncConfig {
  /** Extra/override globs for the files a push sends. */
  include?: string[]
  /** Globs removed from the synced set (hard secret exclusions always win). */
  exclude?: string[]
  /** Per-file cap enforced by the server (default 20 MB). */
  maxFileBytes?: number
  /** `http` is implemented; `git` is reserved and rejected by the CLI. */
  mode?: RemoteSyncMode
}
