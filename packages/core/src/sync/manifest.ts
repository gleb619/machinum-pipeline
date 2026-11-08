import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BuildManifestOptions,
  SyncHashCache,
  SyncManifestEntry,
  SyncScopeOptions,
} from '../types.js'
import { isProtectedSyncPath, normalizeSyncPath, walkSyncFiles } from './scope.js'

export function createSyncHashCache(): SyncHashCache {
  const values = new Map<string, string>()
  const key = (path: string, size: number, mtime: number): string => `${path}\0${size}\0${mtime}`
  return {
    get(path, size, mtime) {
      return values.get(key(path, size, mtime))
    },
    set(path, size, mtime, sha256) {
      values.set(key(path, size, mtime), sha256)
    },
    clear() {
      values.clear()
    },
  }
}

/** Stream a file through SHA-256 so a large input never has to fit in memory. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', rejectPromise)
    stream.on('end', () => resolvePromise())
  })
  return hash.digest('hex')
}

/**
 * Build a deterministic, sorted manifest. Symlinks and non-files are skipped; hard
 * exclusions apply unless the caller supplies an explicit output file list.
 */
export async function buildManifest(
  root: string,
  options: BuildManifestOptions = {},
): Promise<SyncManifestEntry[]> {
  const files =
    options.files === undefined ? await walkSyncFiles(root, options) : [...new Set(options.files)]
  const hashCache = options.hashCache ?? createSyncHashCache()
  const entries: SyncManifestEntry[] = []

  for (const rawPath of files) {
    const path = normalizeSyncPath(rawPath)
    if (path === undefined) continue
    if (options.files === undefined && isProtectedSyncPath(path, options)) continue
    if (options.files !== undefined && !options.allowRunState && isProtectedSyncPath(path)) continue
    const absolute = join(root, ...path.split('/'))
    let info: Awaited<ReturnType<typeof lstat>> | undefined
    try {
      info = await lstat(absolute)
    } catch {
      continue
    }
    if (!info.isFile() || info.isSymbolicLink()) continue
    const size = info.size
    const mtime = Math.floor(info.mtimeMs)
    const cached = hashCache.get(path, size, mtime)
    const sha256 = cached ?? (await hashFile(absolute))
    hashCache.set(path, size, mtime, sha256)
    entries.push({ path, size, sha256, mtime })
  }

  entries.sort((left, right) => left.path.localeCompare(right.path))
  return entries
}

export function manifestTotalBytes(entries: readonly SyncManifestEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.size, 0)
}
