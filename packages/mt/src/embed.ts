import { dirname } from 'node:path'
import * as core from '@mt/core'
import * as tools from '@mt/tools'
import * as waypoint from '@mt/waypoint'
import * as zod from 'zod'
import { resolveFromNodeModules } from './node-resolve.js'

interface BunPluginBuilder {
  module(
    specifier: string,
    callback: () => { exports: Record<string, unknown>; loader: 'object' },
  ): void
  onResolve(
    options: { filter: RegExp },
    callback: (args: ResolveArgs) => ResolveResult | undefined,
  ): void
}

interface ResolveArgs {
  path: string
  importer: string
}

interface ResolveResult {
  path: string
  namespace: string
}

interface BunLike {
  resolveSync(specifier: string, from: string): string
  plugin(plugin: { name: string; setup(build: BunPluginBuilder): void }): void
}

/**
 * Bare specifiers only: no relative/absolute paths, no `node:`/`bun:`/`file:` schemes and no
 * `mt`/`@mt/*` specifiers (those are served by the virtual modules registered below).
 */
const BARE_SPECIFIER = /^(?![./])(?![^/]*:)(?!@?mt($|\/))/

/** Directory of the importing module, used as the base of the package lookup. */
function importerDir(importer: string): string {
  if (!importer || importer.startsWith('/$bunfs')) return process.cwd()
  return dirname(importer)
}

/**
 * Resolve a bare specifier the way Node would: Bun's own resolver first, the manual
 * `node_modules` walk second. Returns undefined when neither can find the package.
 */
function resolveBareSpecifier(
  bun: BunLike,
  specifier: string,
  importer: string,
): string | undefined {
  const from = importerDir(importer)
  try {
    return bun.resolveSync(specifier, from)
  } catch {
    return resolveFromNodeModules(specifier, from)
  }
}

/**
 * Inside a `bun build --compile` binary there is no node_modules, so user pipelines that do
 * `import ... from 'mt'` would fail to resolve. Register virtual modules that point at the
 * copies embedded in the binary (same instances the CLI/Runner uses, so URI registry and
 * class identity are shared). No-op under Node.
 *
 * `zod` is registered as a fallback only: a project that ships its own copy gets it (the
 * pipeline loader resolves it per importer), a project without one gets the embedded copy.
 *
 * Returns true when the plugin was registered.
 */
export function registerEmbeddedModules(): boolean {
  const bun = (globalThis as { Bun?: BunLike }).Bun
  if (!bun || typeof bun.plugin !== 'function') return false

  const rootExports = { ...core }
  const specs: Record<string, Record<string, unknown>> = {
    mt: rootExports,
    '@mt/core': rootExports,
    'mt/tools': { ...tools },
    '@mt/tools': { ...tools },
    'mt/waypoint': { ...waypoint },
    '@mt/waypoint': { ...waypoint },
    zod: { ...zod, default: zod.z },
  }

  bun.plugin({
    name: 'mt-embedded',
    setup(build) {
      for (const [spec, exports] of Object.entries(specs)) {
        build.module(spec, () => ({ exports, loader: 'object' }))
      }

      // Per-import resolution of third-party packages: the project's own copy wins. Also repairs
      // Bun's compiled-binary resolution, which only finds packages whose entry point sits at
      // the package root.
      build.onResolve({ filter: BARE_SPECIFIER }, (args) => {
        const resolved = resolveBareSpecifier(bun, args.path, args.importer)
        return resolved ? { path: resolved, namespace: 'file' } : undefined
      })
    },
  })
  return true
}
