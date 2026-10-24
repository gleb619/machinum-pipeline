// Build the single-file `mt` binary with Bun. Run: bun scripts/build-bin.ts [--target <t>] [--outfile <p>]
//   --target  bun-linux-x64 (default: host) | bun-linux-arm64 | bun-darwin-arm64 | bun-darwin-x64 | bun-windows-x64
// Requires `pnpm build` first (bundles dist/bin.js). `mt serve` (nitropack/admin backend) is excluded.
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const target = flag('--target')
const outfile = resolve(root, flag('--outfile') ?? 'dist/bin/mt')
mkdirSync(dirname(outfile), { recursive: true })

const result = await Bun.build({
  entrypoints: [resolve(root, 'dist/bin.js')],
  compile: target ? { target: target as never, outfile } : { outfile },
  minify: false,
  plugins: [
    {
      name: 'mt-exclude-serve',
      setup(build) {
        // Replace the lazy `serve` command (pulls nitropack, ~tens of MB, needs node + source tree)
        build.onResolve({ filter: /commands\/serve\.js$/ }, () => ({
          path: 'mt-serve-stub',
          namespace: 'mt-stub',
        }))
        build.onLoad({ filter: /.*/, namespace: 'mt-stub' }, () => ({
          loader: 'js',
          contents: `export async function serveCommand() {
  console.error('mt serve is not included in the single-file binary.')
  console.error('Install the npm package ("mt") or run the backend from the repo instead.')
  process.exit(1)
}`,
        }))
      },
    },
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log(`mt: built ${outfile}${target ? ` (${target})` : ''}`)
