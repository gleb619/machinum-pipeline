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
    expect(src).toMatch(/import\s*\{[^}]*\bRunner\b[^}]*\}\s*from\s+['"]@mt\/core['"]/s)
    expect(src).toMatch(/\.resume\(/)
  })

  it('resumeCommand builds its GlobalContext with the shared core loader', async () => {
    const src = await readResumeTs()
    expect(src).toMatch(/loadGlobalContext/)
    expect(src).toMatch(/from ['"]@mt\/core['"]/)
    expect(src).toMatch(/globalContext/)
    // Hand-rolled mt.json parsing must be gone — one loader for CLI and backend
    expect(src).not.toMatch(/JSON\.parse/)
    expect(src).not.toMatch(/mt\.json/)
  })
})
