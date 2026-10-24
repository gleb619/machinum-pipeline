// Build the single-file `mt` binary with Bun.
// Run: bun scripts/build-bin.ts [--target <t>] [--outfile <p>] [--all]
//   --target  bun-linux-x64 | bun-linux-x64-musl | bun-linux-arm64 | bun-linux-arm64-musl |
//             bun-darwin-x64 | bun-darwin-arm64 | bun-windows-x64   (default: host)
//   --outfile default: dist/bin/mt (host) or dist/bin/mt-<os>-<arch>[-musl][.exe] (with --target)
//   --all     build the host binary and every cross target
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

/** Every target the release matrix covers. */
const ALL_TARGETS = [
  'bun-linux-x64',
  'bun-linux-x64-musl',
  'bun-linux-arm64',
  'bun-linux-arm64-musl',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-windows-x64',
]

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

// Generated entry: registers the embedded admin UI (URL path -> embedded file) before the CLI starts.
function embedAssets(dir: string, globalName: string, genFile: string): string {
  let files: string[] = []
  try {
    files = [...walk(dir)]
  } catch {
    console.warn(`mt: ${dir} missing (run \`pnpm build\`); binary will serve the API only`)
  }
  const lines = files.map((f, i) => `import f${i} from ${JSON.stringify(f)} with { type: 'file' }`)
  const map = files.map(
    (f, i) => `  ${JSON.stringify(`/${relative(dir, f).split('\\').join('/')}`)}: f${i},`,
  )
  const gen = join(dist, genFile)
  writeFileSync(gen, `${lines.join('\n')}\nglobalThis.${globalName} = {\n${map.join('\n')}\n}\n`)
  return genFile
}

embedAssets(join(dist, 'ui'), '__MT_UI__', 'ui-embedded.gen.js')
embedAssets(join(dist, 'router-ui'), '__MT_ROUTER_UI__', 'router-ui-embedded.gen.js')
const entry = join(dist, 'bin-entry.gen.js')
writeFileSync(
  entry,
  "import './ui-embedded.gen.js'\nimport './router-ui-embedded.gen.js'\nimport './bin.js'\n",
)

// Not bundled into the binary:
// - `openai` / `@anthropic-ai/sdk` — the official SDK transports are optional; the tools fall back
//   to their fetch adapters when the package is not resolvable (always the case inside the binary).
// - `better-sqlite3` — a native addon; the binary uses the built-in `bun:sqlite` driver instead.
const external = ['openai', '@anthropic-ai/sdk']

// `tiktoken` ships a WebAssembly module that Bun's bundler mis-compiles, so the token counter
// traps inside the binary. The shim uses the pure JavaScript `gpt-tokenizer` (same BPE).
const tiktokenShim = join(root, 'scripts', 'tiktoken-shim.ts')
const plugins = [
  {
    name: 'mt-tiktoken-shim',
    setup(build: { onResolve(options: { filter: RegExp }, cb: () => { path: string }): void }) {
      build.onResolve({ filter: /^tiktoken$/ }, () => ({ path: tiktokenShim }))
    },
  },
]

async function buildFor(compileTarget: string | undefined, compileOutfile: string) {
  const result = await Bun.build({
    entrypoints: [entry],
    external,
    plugins,
    compile: compileTarget
      ? { target: compileTarget as never, outfile: compileOutfile }
      : { outfile: compileOutfile },
    minify: true,
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  console.log(`mt: built ${compileOutfile}${compileTarget ? ` (${compileTarget})` : ''}`)
}

if (argv.includes('--all')) {
  // the host binary first (`dist/bin/mt`), then every cross target
  await buildFor(undefined, resolve(root, 'dist/bin/mt'))
  for (const t of ALL_TARGETS) {
    const sfx = `-${t.replace(/^bun-/, '')}${t.includes('windows') ? '.exe' : ''}`
    const file = resolve(root, `dist/bin/mt${sfx}`)
    mkdirSync(dirname(file), { recursive: true })
    await buildFor(t, file)
  }
} else {
  await buildFor(target, outfile)
}

for (const f of ['ui-embedded.gen.js', 'bin-entry.gen.js']) rmSync(join(dist, f), { force: true })
