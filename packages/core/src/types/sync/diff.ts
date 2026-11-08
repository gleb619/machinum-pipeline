import type { SyncManifestEntry } from './manifest.js'

/** Symmetric manifest diff. `source` is the side that would be written to `target`. */
export interface SyncDiff {
  added: SyncManifestEntry[]
  changed: SyncManifestEntry[]
  removed: string[]
  removedEntries: SyncManifestEntry[]
  unchanged: SyncManifestEntry[]
}
