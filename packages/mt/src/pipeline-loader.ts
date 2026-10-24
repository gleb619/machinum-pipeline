/**
 * Pipeline loader for the single-file binary.
 *
 * Bun's runtime resolver inside a `bun build --compile` executable only finds packages whose entry
 * point sits at the package root (`<pkg>/index.js`): a package that points `main`/`exports` into a
 * subdirectory (`better-sqlite3` -> `lib/index.js`) is reported as "Cannot find package", even when
 * the project installed it. The loader works around that by resolving the pipeline's bare
 * specifiers itself — per importer, so the project's own copy of a library wins over the copy
 * embedded in the binary — and rewriting them to absolute paths before the module is loaded.
 *
 * Only the specifiers that need it are rewritten: a pipeline that imports nothing but `mt` and
 * relative files is loaded unchanged, so `import.meta.url`, relative imports and the derived
 * pipeline id stay exactly as they are.
 */
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { derivePipelineId, nativeAddonHint, packageResolutionHint } from '@mt/core'
import { resolvePackage } from './node-resolve.js'

/** Specifiers served by the binary itself — they must not be rewritten. */
const BINARY_SPECIFIERS = new Set([
  'mt',
  'mt/tools',
  'mt/waypoint',
  '@mt/core',
  '@mt/tools',
  '@mt/waypoint',
])

/** Libraries embedded in the binary: the project's own copy wins when it has one. */
const EMBEDDED_FALLBACKS = new Set(['zod'])

/** `import x from '...'`, `import '...'`, `export ... from '...'`, `import('...')`. */
const IMPORT_PATTERN = /(\bfrom\s*|\bimport\s*|\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g

/** True for a bare specifier (`pkg`, `@scope/pkg`, `pkg/sub`) that Node would look up in node_modules. */
export function isBareSpecifier(specifier: string): boolean {
  if (!specifier) return false
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false
  if (specifier.includes(':')) return false // node:, bun:, file:, http:, ...
  return true
}

/**
 * True when Bun's compiled-binary resolver would find the package on its own: it only looks for
 * `<pkg>/index.js`, so a package with a `main`/`exports` entry in a subdirectory is invisible to it.
 */
function isRuntimeVisible(pkgDir: string, entry: string): boolean {
  return entry === join(pkgDir, 'index.js')
}

/**
 * Rewrite the bare specifiers of a module to absolute paths, resolving them against `dir`.
 * Unresolvable specifiers are left alone, so the runtime reports them as usual.
 */
export function rewriteSpecifiers(source: string, dir: string): string {
  return source.replace(IMPORT_PATTERN, (match, keyword: string, quote: string, spec: string) => {
    if (!isBareSpecifier(spec) || BINARY_SPECIFIERS.has(spec)) return match
    const resolved = resolvePackage(spec, dir)
    if (!resolved) return match
    const needsRewrite =
      EMBEDDED_FALLBACKS.has(spec) || !isRuntimeVisible(resolved.pkgDir, resolved.entry)
    if (!needsRewrite) return match
    return `${keyword}${quote}${resolved.entry}${quote}`
  })
}

/** Path of the rewritten copy of a pipeline module (next to the original). */
function rewrittenPath(filePath: string, source: string): string {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12)
  const ext = extname(filePath) || '.ts'
  const name = basename(filePath, ext)
  return join(dirname(filePath), `.${name}.${hash}.mt${ext}`)
}

/** Restore the id the pipeline would have had when loaded from its original path. */
function restorePipelineId(
  module: Record<string, unknown>,
  originalPath: string,
  copyPath: string,
): void {
  const expected = derivePipelineId(originalPath)
  const derived = derivePipelineId(copyPath)
  if (expected === derived) return
  for (const key of ['default', 'pipeline']) {
    const candidate = module[key]
    if (!candidate || typeof candidate !== 'object') continue
    const pipeline = candidate as { id?: unknown }
    // Only an auto-derived id is corrected — an explicit `definePipeline({ id })` is kept.
    if (pipeline.id !== derived) continue
    Object.defineProperty(candidate, 'id', {
      value: expected,
      enumerable: true,
      configurable: true,
    })
  }
}

/**
 * Load a pipeline module. Under Bun the imports are resolved per importer; everywhere else the
 * module is imported as-is.
 */
export async function importPipelineModule(filePath: string): Promise<Record<string, unknown>> {
  const bun = (globalThis as { Bun?: unknown }).Bun
  if (!bun) return (await import(filePath)) as Record<string, unknown>

  let source: string
  try {
    source = readFileSync(filePath, 'utf8')
  } catch {
    return importPlain(filePath)
  }

  const rewritten = rewrittenPath(filePath, source)
  const code = rewriteSpecifiers(source, dirname(filePath))
  if (code === source) return importPlain(filePath)

  try {
    writeFileSync(rewritten, code)
    const module = (await import(rewritten)) as Record<string, unknown>
    restorePipelineId(module, filePath, rewritten)
    return module
  } catch (error) {
    throw withHint(error)
  } finally {
    rmSync(rewritten, { force: true })
  }
}

/** Import a module as-is, adding the binary's limitation hints to a load failure. */
async function importPlain(filePath: string): Promise<Record<string, unknown>> {
  try {
    return (await import(filePath)) as Record<string, unknown>
  } catch (error) {
    throw withHint(error)
  }
}

/** Append the hint that explains what the binary cannot load. */
function withHint(error: unknown): unknown {
  const hint = nativeAddonHint(error) || packageResolutionHint(error)
  return hint ? new Error(`${(error as Error).message}${hint}`) : error
}
