// Assemble the publishable `mt` package: copy built @mt/{core,tools,waypoint,backend,router,cli} into
// dist/<name>/ (no maps/tests), rewrite `@mt/<name>[/sub]` specifiers to relative paths so the
// tarball is standalone. Third-party deps are declared in package.json `dependencies`.
// Also copies the built admin UI (packages/frontend/dist) to dist/ui for `mt serve`, and the router
// dashboard (packages/router/public) to dist/router-ui for `mt router`.
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const pkgs = ['core', 'tools', 'waypoint', 'backend', 'router', 'cli']

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

for (const name of pkgs) {
  const from = resolve(root, '..', name, 'dist')
  const to = join(dist, name)
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !/\.(map|tsbuildinfo)$/.test(src) && !/\.test\.(js|d\.ts)$/.test(src),
  })
}

const uiSrc = resolve(root, '..', 'frontend', 'dist')
rmSync(join(dist, 'ui'), { recursive: true, force: true })
try {
  cpSync(uiSrc, join(dist, 'ui'), { recursive: true })
} catch {
  console.warn('mt: packages/frontend/dist missing; admin UI not included (run pnpm build)')
}

// The router dashboard ships as plain static files (no build step), so the source dir is the asset dir.
const routerUiSrc = resolve(root, '..', 'router', 'public')
rmSync(join(dist, 'router-ui'), { recursive: true, force: true })
try {
  cpSync(routerUiSrc, join(dist, 'router-ui'), { recursive: true })
} catch {
  console.warn('mt: packages/router/public missing; router dashboard not included')
}

// Only import/export-from contexts, so plain string literals (e.g. embed.ts keys) stay intact.
const re =
  /\b(from\s*|import\s*\(\s*|import\s+)(['"])@mt\/(core|tools|waypoint|backend|router|cli)(\/[^'"]*)?\2/g
let rewritten = 0
for (const file of walk(dist)) {
  if (!/\.(js|d\.ts)$/.test(file)) continue
  const src = readFileSync(file, 'utf8')
  const out = src.replace(re, (_m, kw, q, name, sub) => {
    let target = join(dist, name, sub ? sub.slice(1) : 'index.js')
    if (sub && !/\.[cm]?js$/.test(target)) target += '.js'
    let rel = relative(dirname(file), target)
    if (!rel.startsWith('.')) rel = `./${rel}`
    return `${kw}${q}${rel}${q}`
  })
  if (out !== src) {
    writeFileSync(file, out)
    rewritten++
  }
}
console.log(`mt: assembled ${pkgs.join(', ')} (${rewritten} files rewritten)`)
