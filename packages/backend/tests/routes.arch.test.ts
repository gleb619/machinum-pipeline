import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function fileExists(relativePath: string): Promise<boolean> {
  try {
    await access(join(__dirname, relativePath))
    return true
  } catch {
    return false
  }
}

describe('UC-27 - Admin API Routes & Config (architectural)', () => {
  it('nitro.config.ts exists', async () => {
    expect(await fileExists('../nitro.config.ts')).toBe(true)
  })

  it('vitest.config.ts exists', async () => {
    expect(await fileExists('../vitest.config.ts')).toBe(true)
  })

  it('health route exists', async () => {
    expect(await fileExists('../server/routes/api/health.ts')).toBe(true)
  })

  it('runs index route exists', async () => {
    expect(await fileExists('../server/routes/api/runs/index.ts')).toBe(true)
  })

  it('run detail route exists', async () => {
    expect(await fileExists('../server/routes/api/runs/[id].ts')).toBe(true)
  })

  it('run events SSE route exists', async () => {
    expect(await fileExists('../server/routes/api/runs/[id]/events.ts')).toBe(true)
  })

  it('pipelines route exists', async () => {
    expect(await fileExists('../server/routes/api/pipelines.ts')).toBe(true)
  })

  it('runs start route exists', async () => {
    expect(await fileExists('../server/routes/api/runs/start.ts')).toBe(true)
  })

  it('run pause route exists', async () => {
    expect(await fileExists('../server/routes/api/runs/[id]/pause.ts')).toBe(true)
  })

  it('run resume route exists', async () => {
    expect(await fileExists('../server/routes/api/runs/[id]/resume.ts')).toBe(true)
  })
})
