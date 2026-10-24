// Build the single-file `mt` binary with Bun. Run: bun scripts/build-bin.ts [--target <t>] [--outfile <p>]
//   --target  bun-linux-x64 | bun-linux-x64-musl | bun-linux-arm64 | bun-linux-arm64-musl |
//             bun-darwin-x64 | bun-darwin-arm64 | bun-windows-x64   (default: host)
//   --outfile default: dist/bin/mt (host) or dist/bin/mt-<os>-<arch>[-musl][.exe] (with --target)
// Requires `pnpm build` first (bundles dist/bin.js and embeds dist/ui, the admin UI build).
// Includes `mt serve`: h3 admin API + bun:sqlite + embedded UI (no node/node_modules needed).
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const target = flag('--target')
const suffix = target
  ? `-${target.replace(/^bun-/, '')}${target.includes('windows') ? '.exe' : ''}`
  : ''
const outfile = resolve(root, flag('--outfile') ?? `dist/bin/mt${suffix}`)
mkdirSync(dirname(outfile), { recursive: true })

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

// Generated entry: registers the embedded admin UI (URL path -> embedded file) before the CLI starts.
const uiDir = join(dist, 'ui')
let uiFiles: string[] = []
try {
  uiFiles = [...walk(uiDir)]
} catch {
  console.warn('mt: dist/ui missing (run `pnpm build`); binary will serve the API only')
}
const lines = uiFiles.map((f, i) => `import f${i} from ${JSON.stringify(f)} with { type: 'file' }`)
const map = uiFiles.map(
  (f, i) => `  ${JSON.stringify(`/${relative(uiDir, f).split('\\').join('/')}`)}: f${i},`,
)
writeFileSync(
  join(dist, 'ui-embedded.gen.js'),
  `${lines.join('\n')}\nglobalThis.__MT_UI__ = {\n${map.join('\n')}\n}\n`,
)
const entry = join(dist, 'bin-entry.gen.js')
writeFileSync(entry, "import './ui-embedded.gen.js'\nimport './bin.js'\n")

const result = await Bun.build({
  entrypoints: [entry],
  compile: target ? { target: target as never, outfile } : { outfile },
  minify: false,
})

for (const f of ['ui-embedded.gen.js', 'bin-entry.gen.js']) rmSync(join(dist, f), { force: true })

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log(`mt: built ${outfile}${target ? ` (${target})` : ''}`)
