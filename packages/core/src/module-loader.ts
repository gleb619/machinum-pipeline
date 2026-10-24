/**
 * Loading of user pipeline modules.
 *
 * Pipelines are plain TypeScript modules loaded at runtime. The single-file `mt` binary installs
 * its own loader (see `packages/mt`) that resolves the pipeline's imports per importer, so a
 * project can ship its own copy of a third-party library and still fall back to the copy embedded
 * in the binary. Everything else (Node, `tsx`, ...) uses the plain dynamic import.
 */

/** Loader installed by the single-file binary. */
export type PipelineModuleLoader = (filePath: string) => Promise<Record<string, unknown>>

interface LoaderGlobal {
  __MT_IMPORT_PIPELINE__?: PipelineModuleLoader
}

/** Install (or remove) the pipeline module loader. */
export function setPipelineModuleLoader(loader: PipelineModuleLoader | undefined): void {
  const scope = globalThis as LoaderGlobal
  if (loader) scope.__MT_IMPORT_PIPELINE__ = loader
  else scope.__MT_IMPORT_PIPELINE__ = undefined
}

/** Load a pipeline module, using the installed loader when there is one. */
export async function importPipelineModule(filePath: string): Promise<Record<string, unknown>> {
  const loader = (globalThis as LoaderGlobal).__MT_IMPORT_PIPELINE__
  if (loader) return loader(filePath)
  return (await import(filePath)) as Record<string, unknown>
}

const NATIVE_ADDON_PATTERNS = [
  /invalid ELF header/i,
  /was compiled against a different Node\.js version/i,
  /NODE_MODULE_VERSION/,
  /dlopen/i,
  /Failed to load native binding/i,
  /native binding/i,
  /\.node['"]/,
]

/** True when the failure comes from loading a compiled native addon. */
export function isNativeAddonError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return NATIVE_ADDON_PATTERNS.some((pattern) => pattern.test(message))
}

const PACKAGE_RESOLUTION_PATTERNS = [/Cannot find package/i, /Cannot find module/i]

/** True when the failure is a package that could not be resolved. */
export function isPackageResolutionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return PACKAGE_RESOLUTION_PATTERNS.some((pattern) => pattern.test(message))
}

/**
 * Hint appended to a pipeline load failure: the single-file binary resolves packages from the
 * project's `node_modules`, but only packages whose entry point is `<pkg>/index.js` are visible
 * to Bun's compiled-binary resolver. Native addons cannot be loaded at all.
 */
export function packageResolutionHint(error: unknown): string {
  if (!isPackageResolutionError(error)) return ''
  return [
    '',
    "The `mt` binary resolves packages from the project's node_modules, but only packages",
    'whose entry point is `<pkg>/index.js` are visible to it — packages that point',
    '`main`/`exports` into a subdirectory, and native addons (better-sqlite3, sharp, ...),',
    'are not supported by the binary. Run the pipeline with the `mt` npm package (Node) for',
    'full support.',
  ].join('\n')
}

/**
 * Hint appended to a pipeline load failure: native addons cannot be loaded by the single-file
 * binary, and the raw loader error ("invalid ELF header") does not say so.
 */
export function nativeAddonHint(error: unknown): string {
  if (!isNativeAddonError(error)) return ''
  return [
    '',
    'Native addons are not supported by the `mt` binary.',
    'The single-file binary cannot load compiled Node addons (better-sqlite3, sharp, ...).',
    'Use a pure JavaScript alternative, or run the pipeline with the `mt` npm package (Node).',
  ].join('\n')
}
