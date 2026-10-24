import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

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

/** All `@mt/*` imports of the MCP sources. */
async function mtImports(): Promise<string[]> {
  const specifiers: string[] = []
  for (const file of await collectFiles(srcDir)) {
    const source = await readFile(file, 'utf8')
    const pattern = /(?:import\s*\(\s*|from\s*|import\s+)(['"])(@mt\/[^'"]+)\1/g
    let match = pattern.exec(source)
    while (match) {
      specifiers.push(match[2] as string)
      match = pattern.exec(source)
    }
  }
  return specifiers
}

describe('MCP import layers (architectural)', () => {
  it('imports only @mt/core', async () => {
    const offenders = (await mtImports()).filter((specifier) => specifier !== '@mt/core')
    expect(offenders).toEqual([])
  })
})
