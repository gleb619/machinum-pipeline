/**
 * Minimal Node-style package resolution for the single-file binary.
 *
 * Bun's own resolver inside a `bun build --compile` executable only finds packages whose entry
 * point sits at the package root (`<pkg>/index.js`). A package that points `main`/`exports` into a
 * subdirectory (`better-sqlite3` -> `lib/index.js`, `zod` -> `lib/index.js`, ...) is reported as
 * "Cannot find package", even when it is installed in the user's `node_modules`. This module
 * implements the missing part: walk `node_modules` upwards from the importer and apply the
 * `exports`/`main` rules of the package manifest.
 *
 * It is only used as a fallback — Bun's resolution always wins when it succeeds.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

interface PackageManifest {
  name?: string
  main?: string
  exports?: unknown
}

const INDEX_FILES = ['index.js', 'index.mjs', 'index.cjs', 'index.json', 'index.node']

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readManifest(pkgDir: string): PackageManifest {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as PackageManifest
  } catch {
    return {}
  }
}

/** Resolve a directory to its index file, if any. */
function resolveAsDirectory(dir: string): string | undefined {
  if (!isDirectory(dir)) return undefined
  for (const name of INDEX_FILES) {
    const candidate = join(dir, name)
    if (isFile(candidate)) return candidate
  }
  return undefined
}

/** Follow the `exports` conditions of a manifest, preferring the ESM entry. */
function resolveConditions(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = resolveConditions(entry)
      if (resolved) return resolved
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const map = value as Record<string, unknown>
  for (const condition of ['import', 'node', 'module', 'browser', 'default', 'require']) {
    if (condition in map) {
      const resolved = resolveConditions(map[condition])
      if (resolved) return resolved
    }
  }
  return undefined
}

/** Resolve the `exports` field for a subpath ('.' is the package root). */
function resolveExports(field: unknown, subpath: string): string | undefined {
  if (!field) return undefined
  if (typeof field === 'string') return subpath === '.' ? field : undefined
  if (typeof field !== 'object') return undefined
  const map = field as Record<string, unknown>
  const keys = Object.keys(map)
  const isSubpathMap = keys.length > 0 && keys.every((key) => key.startsWith('.'))
  if (isSubpathMap) {
    if (!(subpath in map)) return undefined
    return resolveConditions(map[subpath])
  }
  return subpath === '.' ? resolveConditions(map) : undefined
}

/** Split 'pkg/sub/path' into the package name and the subpath below it. */
function splitSpecifier(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '')
  return { name, subpath: specifier.slice(name.length).replace(/^\//, '') }
}

/** Entry point of an installed package, honouring `exports` and `main`. */
export function resolvePackageEntry(pkgDir: string, subpath: string): string | undefined {
  const manifest = readManifest(pkgDir)

  if (subpath) {
    const viaExports = resolveExports(manifest.exports, subpath)
    if (viaExports) {
      const target = join(pkgDir, viaExports)
      if (isFile(target)) return target
      const asDir = resolveAsDirectory(target)
      if (asDir) return asDir
    }
    const direct = join(pkgDir, subpath)
    if (isFile(direct)) return direct
    return resolveAsDirectory(direct)
  }

  const viaExports = resolveExports(manifest.exports, '.')
  if (viaExports) {
    const target = join(pkgDir, viaExports)
    if (isFile(target)) return target
    const asDir = resolveAsDirectory(target)
    if (asDir) return asDir
  }

  if (manifest.main) {
    const main = join(pkgDir, manifest.main)
    if (isFile(main)) return main
    const asDir = resolveAsDirectory(main)
    if (asDir) return asDir
  }

  return resolveAsDirectory(pkgDir)
}

/** A resolved package: its directory and the entry point Bun would load. */
export interface ResolvedPackage {
  /** Directory of the package (the one holding package.json). */
  pkgDir: string
  /** Absolute path of the entry point. */
  entry: string
}

/**
 * Resolve a bare specifier ('pkg', '@scope/pkg', 'pkg/sub') by walking `node_modules` upwards
 * from `fromDir`. Returns the package directory and its entry point, or undefined when not found.
 */
export function resolvePackage(specifier: string, fromDir: string): ResolvedPackage | undefined {
  const { name, subpath } = splitSpecifier(specifier)
  if (!name) return undefined

  let dir = fromDir
  for (;;) {
    const pkgDir = join(dir, 'node_modules', name)
    if (isDirectory(pkgDir)) {
      const entry = resolvePackageEntry(pkgDir, subpath)
      if (entry) return { pkgDir, entry }
    }
    const parent = join(dir, '..')
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Resolve a bare specifier ('pkg', '@scope/pkg', 'pkg/sub') by walking `node_modules` upwards
 * from `fromDir`. Returns the absolute path of the entry point, or undefined when not found.
 */
export function resolveFromNodeModules(specifier: string, fromDir: string): string | undefined {
  return resolvePackage(specifier, fromDir)?.entry
}
