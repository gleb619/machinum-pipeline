import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))

async function readCliIndex(): Promise<string> {
  return readFile(join(testDir, '..', 'src', 'index.ts'), 'utf-8')
}

describe('CLI command registry (architectural)', () => {
  it('CLI index registers run command', async () => {
    const src = await readCliIndex()
    expect(src).toMatch(/case\s+['"]run['"]/)
    expect(src).toMatch(/runCommand/)
  })

  it('CLI index registers resume command', async () => {
    const src = await readCliIndex()
    expect(src).toMatch(/case\s+['"]resume['"]/)
    expect(src).toMatch(/resumeCommand/)
  })

  it('CLI index registers ls runs command', async () => {
    const src = await readCliIndex()
    expect(src).toMatch(/case\s+['"]ls['"]/)
    expect(src).toMatch(/listRunsCommand/)
    expect(src).toMatch(/['\"]runs['\"]/)
  })

  it('CLI index registers inspect command', async () => {
    const src = await readCliIndex()
    expect(src).toMatch(/case\s+['"]inspect['"]/)
    expect(src).toMatch(/inspectCommand/)
  })

  it('CLI index registers tool command', async () => {
    const src = await readCliIndex()
    expect(src).toMatch(/case\s+['"]tool['"]/)
    expect(src).toMatch(/toolCommand/)
  })
})
