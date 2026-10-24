import * as core from '@mt/core'
import * as tools from '@mt/tools'
import * as waypoint from '@mt/waypoint'
import * as zod from 'zod'

interface BunPluginBuilder {
  module(
    specifier: string,
    callback: () => { exports: Record<string, unknown>; loader: 'object' },
  ): void
}

interface BunLike {
  resolveSync(specifier: string, from: string): string
  plugin(plugin: { name: string; setup(build: BunPluginBuilder): void }): void
}

function resolvableFromCwd(bun: BunLike, spec: string): boolean {
  try {
    bun.resolveSync(spec, process.cwd())
    return true
  } catch {
    return false
  }
}

/**
 * Inside a `bun build --compile` binary there is no node_modules, so user pipelines that do
 * `import ... from 'mt'` would fail to resolve. Register virtual modules that point at the
 * copies embedded in the binary (same instances the CLI/Runner uses, so URI registry and
 * class identity are shared). No-op under Node.
 *
 * Returns true when virtual modules were registered.
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
  }

  // Third-party libs bundled in the binary, registered ONLY when the project (cwd) does not
  // provide them itself (a node_modules package resolvable from cwd wins).
  const fallbacks: Record<string, Record<string, unknown>> = { zod: { ...zod, default: zod.z } }

  bun.plugin({
    name: 'mt-embedded',
    setup(build) {
      for (const [spec, exports] of Object.entries(specs)) {
        build.module(spec, () => ({ exports, loader: 'object' }))
      }
      for (const [spec, exports] of Object.entries(fallbacks)) {
        if (!resolvableFromCwd(bun, spec)) build.module(spec, () => ({ exports, loader: 'object' }))
      }
    },
  })
  return true
}
