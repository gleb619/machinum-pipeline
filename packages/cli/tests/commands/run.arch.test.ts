import { describe, expect, it } from 'vitest'

describe('UC-49 — Load pipelines without build step (architectural)', () => {
  it('run.ts uses dynamic import() for loading .ts pipeline files', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const srcPath = join(__dirname, '..', '..', 'src', 'commands', 'run.ts')
    const source = await readFile(srcPath, 'utf-8')

    // Must use dynamic import() — not require() or static import of pipeline
    expect(source).toMatch(/import\(/)
    // Should NOT use require() for loading pipeline modules
    expect(source).not.toMatch(/require\(/)
  })

  it('runCommand is exported', async () => {
    const mod = await import('../../src/commands/run.js')
    expect(mod).toHaveProperty('runCommand')
    expect(typeof mod.runCommand).toBe('function')
  })
})
