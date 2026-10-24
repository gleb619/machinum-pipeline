import { describe, expect, it } from 'vitest'

describe('UC-49 — Load pipelines without build step (architectural)', () => {
  it('run.ts loads pipelines through the no-build dynamic importer', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const srcPath = join(__dirname, '..', '..', 'src', 'commands', 'run.ts')
    const source = await readFile(srcPath, 'utf-8')

    // Must delegate to @mt/core's importPipelineModule (dynamic import under the hood)
    expect(source).toMatch(/importPipelineModule/)
    expect(source).toMatch(/from ['"]@mt\/core['"]/)
    // Should NOT use require() for loading pipeline modules
    expect(source).not.toMatch(/require\(/)
  })

  it('runCommand is exported', async () => {
    const mod = await import('../../src/commands/run.js')
    expect(mod).toHaveProperty('runCommand')
    expect(typeof mod.runCommand).toBe('function')
  })
})
