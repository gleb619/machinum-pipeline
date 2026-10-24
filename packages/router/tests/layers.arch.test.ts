import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(pkgDir, 'server')

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(path)))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

/** All `@mt/*` specifiers in the router sources, as `file:specifier` pairs. */
async function mtImports(): Promise<string[]> {
  const offenders: string[] = []
  for (const file of await collectFiles(srcDir)) {
    const source = await readFile(file, 'utf8')
    const pattern = /(?:import\s*\(\s*|from\s*|import\s+)(['"])(@mt\/[^'"]+)\1/g
    let match = pattern.exec(source)
    while (match) {
      offenders.push(`${relative(pkgDir, file)} → ${match[2] as string}`)
      match = pattern.exec(source)
    }
  }
  return offenders
}

/** Dependency names in `package.json` (`@mt/*` only, `dependencies` + `devDependencies`). */
async function mtDeps(): Promise<string[]> {
  const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].filter(
    (name) => name.startsWith('@mt/'),
  )
}

describe('router stays standalone (architectural)', () => {
  it('server sources import no @mt/* package', async () => {
    expect(await mtImports()).toEqual([])
  })

  it('package.json declares no @mt/* dependency', async () => {
    expect(await mtDeps()).toEqual([])
  })
})
