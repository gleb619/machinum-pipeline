import type { Dirent } from 'node:fs'
import { readFileSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'

/**
 * The single read tool module of @mt/tools: the ONLY file in src/ allowed to
 * import node:fs / node:fs/promises. All filesystem reads — and the
 * stat/readdir primitives used by directory walks — live here; every other
 * module delegates to these helpers.
 */

/** Read a utf-8 text file. */
export function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf-8')
}

/** Synchronous utf-8 read, for inherently sync call sites (prompt template loading). */
export function readTextFileSync(path: string): string {
  return readFileSync(path, 'utf8')
}

/** List a directory's entries with their file types. */
export function readDirectory(path: string): Promise<Dirent[]> {
  return readdir(path, { withFileTypes: true })
}

/** True when `path` exists and is a directory. */
export async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path)).isDirectory()
}
