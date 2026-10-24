import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** `@mt/*` packages the CLI is allowed to import. */
const ALLOWED = new Set([
  '@mt/core',
  '@mt/waypoint',
  '@mt/backend/standalone',
  '@mt/router/standalone',
])

interface ImportRef {
  file: string
  specifier: string
  dynamic: boolean
}

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

/** All `@mt/*` imports of the CLI sources, with their kind. */
async function mtImports(): Promise<ImportRef[]> {
  const refs: ImportRef[] = []
  for (const file of await collectFiles(srcDir)) {
    const source = await readFile(file, 'utf8')
    const pattern = /(import\s*\(\s*|from\s*|import\s+)(['"])(@mt\/[^'"]+)\2/g
    let match = pattern.exec(source)
    while (match) {
      refs.push({
        file: relative(srcDir, file),
        specifier: match[3] as string,
        dynamic: match[1]?.includes('(') === true,
      })
      match = pattern.exec(source)
    }
  }
  return refs
}

describe('CLI import layers (architectural)', () => {
  it('imports only @mt/core, @mt/waypoint and the standalone server entry points', async () => {
    const refs = await mtImports()
    const offenders = refs.filter((ref) => !ALLOWED.has(ref.specifier))
    expect(offenders).toEqual([])
  })

  it('reaches the server packages only through their standalone entry point', async () => {
    const refs = await mtImports()
    for (const pkg of ['@mt/backend', '@mt/router']) {
      const serverRefs = refs.filter((ref) => ref.specifier.startsWith(pkg))
      expect(serverRefs.length).toBeGreaterThan(0)
      for (const ref of serverRefs) {
        expect(ref.specifier).toBe(`${pkg}/standalone`)
      }
    }
  })

  it('imports the server packages lazily, so the CLI starts without h3/SQLite', async () => {
    const refs = await mtImports()
    const serverRefs = refs.filter(
      (ref) => ref.specifier.startsWith('@mt/backend') || ref.specifier.startsWith('@mt/router'),
    )
    for (const ref of serverRefs) {
      expect(ref.dynamic).toBe(true)
    }
  })
})
