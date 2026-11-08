import { lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { atomicWriteFile } from '../atomic.js'
import type { SyncApplyOptions } from '../types/sync/apply.js'
import {
  type SyncScopeOptions,
  isProtectedSyncPath,
  normalizeSyncPath,
  walkSyncFiles,
} from './scope.js'
export type { SyncApplyOptions } from '../types/sync/apply.js'

export class SyncPathError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'SyncPathError'
  }
}

export class SyncProtectedPathError extends SyncPathError {
  constructor(path: string) {
    super(path, `Refusing to sync protected path: ${path}`)
    this.name = 'SyncProtectedPathError'
  }
}

export class SyncSymlinkError extends SyncPathError {
  constructor(path: string) {
    super(path, `Refusing to sync through symlink: ${path}`)
    this.name = 'SyncSymlinkError'
  }
}

export class SyncFileTooLargeError extends SyncPathError {
  constructor(
    path: string,
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(path, `File '${path}' is ${size} bytes; cap is ${maxBytes} bytes`)
    this.name = 'SyncFileTooLargeError'
  }
}

function normalizeOrThrow(path: string): string {
  const normalized = normalizeSyncPath(path)
  if (normalized === undefined) {
    throw new SyncPathError(path, `Invalid sync path: ${path}`)
  }
  return normalized
}

function assertNotProtected(path: string, options: SyncApplyOptions): void {
  if (isProtectedSyncPath(path, options)) throw new SyncProtectedPathError(path)
}

async function lstatOrUndefined(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Resolve a wire path under `root`, rejecting lexical escapes and every existing
 * symlink component. The returned path uses the real root (so a symlinked temp root
 * such as macOS `/tmp` is still fine).
 */
export async function resolveSyncPath(
  root: string,
  path: string,
  options: SyncApplyOptions & { createRoot?: boolean } = {},
): Promise<string> {
  const normalized = normalizeOrThrow(path)
  assertNotProtected(normalized, options)
  if (options.createRoot !== false) await mkdir(root, { recursive: true })
  const realRoot = await realpath(root)
  const segments = normalized.split('/')
  let current = realRoot
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    if (segment === undefined) continue
    current = join(current, segment)
    if (!isInside(realRoot, current)) {
      throw new SyncPathError(path, `Path escapes root: ${path}`)
    }
    const info = await lstatOrUndefined(current)
    if (info?.isSymbolicLink()) throw new SyncSymlinkError(path)
    if (info !== undefined && index < segments.length - 1 && !info.isDirectory()) {
      throw new SyncPathError(path, `Path component is not a directory: ${path}`)
    }
  }
  return current
}

async function ensureParentDirectories(root: string, normalized: string): Promise<string> {
  const segments = normalized.split('/')
  const fileName = segments.pop()
  if (fileName === undefined) throw new SyncPathError(normalized, 'Missing file name')
  await mkdir(root, { recursive: true })
  const realRoot = await realpath(root)
  let current = realRoot
  for (const segment of segments) {
    current = join(current, segment)
    const info = await lstatOrUndefined(current)
    if (info?.isSymbolicLink()) throw new SyncSymlinkError(normalized)
    if (info === undefined) {
      await mkdir(current)
    } else if (!info.isDirectory()) {
      throw new SyncPathError(normalized, `Path component is not a directory: ${normalized}`)
    }
  }
  const target = join(current, fileName)
  if (!isInside(realRoot, target))
    throw new SyncPathError(normalized, `Path escapes root: ${normalized}`)
  const info = await lstatOrUndefined(target)
  if (info?.isSymbolicLink()) throw new SyncSymlinkError(normalized)
  if (info?.isDirectory())
    throw new SyncPathError(normalized, `Target is a directory: ${normalized}`)
  return target
}

function asBuffer(data: string | Uint8Array): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
}

/**
 * Atomic write (sibling temp file -> rename). Parent directories are created one
 * component at a time so a symlinked parent can never redirect the write outside root.
 */
export async function writeSyncFile(
  root: string,
  path: string,
  data: string | Uint8Array,
  options: SyncApplyOptions & { maxBytes?: number } = {},
): Promise<number> {
  const normalized = normalizeOrThrow(path)
  assertNotProtected(normalized, options)
  const buffer = asBuffer(data)
  if (options.maxBytes !== undefined && buffer.length > options.maxBytes) {
    throw new SyncFileTooLargeError(normalized, buffer.length, options.maxBytes)
  }
  const target = await ensureParentDirectories(root, normalized)
  await atomicWriteFile(target, buffer)
  return buffer.length
}

/** Delete one synced file; missing paths are a no-op. */
export async function deleteSyncFile(
  root: string,
  path: string,
  options: SyncApplyOptions = {},
): Promise<boolean> {
  const normalized = normalizeOrThrow(path)
  assertNotProtected(normalized, options)
  let target: string
  try {
    target = await resolveSyncPath(root, normalized, { ...options, createRoot: false })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  const info = await lstatOrUndefined(target)
  if (info === undefined) return false
  if (info.isSymbolicLink()) throw new SyncSymlinkError(normalized)
  if (info.isDirectory())
    throw new SyncPathError(normalized, `Target is a directory: ${normalized}`)
  await unlink(target)
  return true
}

/** Read one synced file without following symlinks. */
export async function readSyncFile(
  root: string,
  path: string,
  options: SyncApplyOptions = {},
): Promise<Buffer> {
  const normalized = normalizeOrThrow(path)
  assertNotProtected(normalized, options)
  const target = await resolveSyncPath(root, normalized, { ...options, createRoot: false })
  return readFile(target)
}

/** Delete every regular file under `root` that is not in `keep`. */
export async function pruneSyncFiles(
  root: string,
  keep: Iterable<string>,
  options: SyncScopeOptions = {},
): Promise<string[]> {
  const keepSet = new Set<string>()
  for (const path of keep) {
    const normalized = normalizeSyncPath(path)
    if (normalized !== undefined) keepSet.add(normalized)
  }
  const deleted: string[] = []
  for (const path of await walkSyncFiles(root, options)) {
    if (keepSet.has(path)) continue
    if (isProtectedSyncPath(path, options)) continue
    if (await deleteSyncFile(root, path, options)) deleted.push(path)
  }
  return deleted.sort()
}
