import { describe, expect, it } from 'vitest'

describe('UC-01 — Initialize project (architectural)', () => {
  it('init.ts exports initCommand', async () => {
    const mod = await import('../../src/commands/init.js')
    expect(mod).toHaveProperty('initCommand')
    expect(typeof mod.initCommand).toBe('function')
  })

  it('initCommand is registered in CLI command switch (verified via source scan)', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const indexPath = join(__dirname, '..', '..', 'src', 'index.ts')
    const source = await readFile(indexPath, 'utf-8')

    // The CLI index must register 'init' as a command case
    expect(source).toMatch(/case\s+['"]init['"]/)
    // And it must call initCommand
    expect(source).toMatch(/initCommand/)
  })

  it('MtConfig type shape — has project.name and pipelines array', async () => {
    const core = await import('@mt/core')
    const cfg = core.DEFAULT_MT_CONFIG
    expect(cfg).toHaveProperty('project')
    expect(cfg.project).toHaveProperty('name')
    expect(typeof cfg.project.name).toBe('string')
    expect(cfg).toHaveProperty('pipelines')
    expect(Array.isArray(cfg.pipelines)).toBe(true)
  })
})
