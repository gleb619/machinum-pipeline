import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))

async function readResumeTs(): Promise<string> {
  return readFile(join(testDir, '..', '..', 'src', 'commands', 'resume.ts'), 'utf-8')
}

describe('UC-06 — Resume command wiring (architectural)', () => {
  it('resume.ts exports resumeCommand', async () => {
    const mod = await import('../../src/commands/resume.js')
    expect(mod).toHaveProperty('resumeCommand')
    expect(typeof mod.resumeCommand).toBe('function')
  })

  it('resumeCommand calls Runner.resume(runId)', async () => {
    const src = await readResumeTs()
    expect(src).toMatch(/import.*Runner.*from\s+['"]@mt\/core['"]/)
    expect(src).toMatch(/\.resume\(/)
  })

  it('resumeCommand reads mt.json for GlobalContext', async () => {
    const src = await readResumeTs()
    expect(src).toMatch(/mt\.json/)
    expect(src).toMatch(/globalContext|GlobalContext/)
  })
})
