import type { SyncDiff } from 'types.js'
import type { SyncManifestEntry } from './manifest.js'

function byPath(entries: readonly SyncManifestEntry[]): Map<string, SyncManifestEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]))
}

/**
 * Compare `source` against `target` by SHA-256 (mtime never decides a change).
 * Added/changed entries come from `source`; removed entries come from `target`.
 */
export function diffManifests(
  source: readonly SyncManifestEntry[],
  target: readonly SyncManifestEntry[],
): SyncDiff {
  const sourceByPath = byPath(source)
  const targetByPath = byPath(target)
  const added: SyncManifestEntry[] = []
  const changed: SyncManifestEntry[] = []
  const unchanged: SyncManifestEntry[] = []
  const removedEntries: SyncManifestEntry[] = []

  for (const entry of source) {
    const peer = targetByPath.get(entry.path)
    if (peer === undefined) added.push(entry)
    else if (peer.sha256 !== entry.sha256) changed.push(entry)
    else unchanged.push(entry)
  }
  for (const entry of target) {
    if (!sourceByPath.has(entry.path)) removedEntries.push(entry)
  }

  added.sort((left, right) => left.path.localeCompare(right.path))
  changed.sort((left, right) => left.path.localeCompare(right.path))
  unchanged.sort((left, right) => left.path.localeCompare(right.path))
  removedEntries.sort((left, right) => left.path.localeCompare(right.path))
  return {
    added,
    changed,
    removed: removedEntries.map((entry) => entry.path),
    removedEntries,
    unchanged,
  }
}

/** Alias matching the plan's `diff` module naming. */
export const diffManifest = diffManifests

export function hasSyncChanges(diff: SyncDiff): boolean {
  return diff.added.length > 0 || diff.changed.length > 0 || diff.removed.length > 0
}

export function manifestHashMap(entries: readonly SyncManifestEntry[]): Map<string, string> {
  return new Map(entries.map((entry) => [entry.path, entry.sha256]))
}
