import * as core from '@mt/core'
import * as tools from '@mt/tools'
import * as waypoint from '@mt/waypoint'

interface BunPluginBuilder {
  module(
    specifier: string,
    callback: () => { exports: Record<string, unknown>; loader: 'object' },
  ): void
}

interface BunLike {
  plugin(plugin: { name: string; setup(build: BunPluginBuilder): void }): void
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

  bun.plugin({
    name: 'mt-embedded',
    setup(build) {
      for (const [spec, exports] of Object.entries(specs)) {
        build.module(spec, () => ({ exports, loader: 'object' }))
      }
    },
  })
  return true
}
