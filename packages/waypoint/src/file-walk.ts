import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * Shared recursive directory walker for waypoint sources.
 *
 * Both `md://` and `chapter-output://` walk a directory tree and collect files
 * matching a predicate; this is the one implementation. Results are returned in
 * walk order — callers sort for their deterministic ordering.
 */

/** What the walker does with one directory entry. */
export type WalkDecision = 'recurse' | 'collect' | 'skip'

export interface WalkEntry {
  /** Base name of the entry. */
  name: string
  /** Absolute path of the entry. */
  fullPath: string
  /** Directory holding the entry, relative to the walked root (`''` at the root). */
  relativeDir: string
  isDirectory: boolean
  isFile: boolean
}

export interface WalkedFile {
  /** Absolute path of the collected file. */
  path: string
  /** Base name of the file. */
  name: string
  /** Directory holding the file, relative to the walked root (`''` at the root). */
  relativeDir: string
}

export interface FileWalkOptions {
  /**
   * `ignore`: a missing/unreadable root directory yields no files (a source with
   * nothing on disk simply emits nothing). `throw` (default) propagates the error.
   */
  onMissingDir?: 'ignore' | 'throw'
}

/**
 * Recursively walk `dir` and collect every file for which `decide` returns
 * `'collect'`. A directory entry returns `'recurse'` to descend into it.
 */
export async function walkFiles(
  dir: string,
  decide: (entry: WalkEntry) => WalkDecision,
  options: FileWalkOptions = {},
): Promise<WalkedFile[]> {
  const results: WalkedFile[] = []

  async function walk(currentDir: string, relativeDir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(currentDir, { withFileTypes: true, encoding: 'utf8' })
    } catch (error) {
      if (options.onMissingDir === 'ignore' && isMissingDirError(error)) return
      throw error
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name)
      let isDirectory = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        // Follow symlinks the way a stat()-based walk does.
        try {
          const info = await stat(fullPath)
          isDirectory = info.isDirectory()
          isFile = info.isFile()
        } catch {
          continue
        }
      }
      const walkEntry: WalkEntry = {
        name: entry.name,
        fullPath,
        relativeDir,
        isDirectory,
        isFile,
      }
      const decision = decide(walkEntry)
      if (decision === 'recurse' && walkEntry.isDirectory) {
        await walk(fullPath, relative(dir, fullPath))
      } else if (decision === 'collect' && walkEntry.isFile) {
        results.push({ path: fullPath, name: entry.name, relativeDir })
      }
    }
  }

  await walk(dir, '')
  return results
}

function isMissingDirError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
