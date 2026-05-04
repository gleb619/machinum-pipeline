import { access } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
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

describe('UC-35,36 - Router Middleware & Rate Limit (architectural)', () => {
  it('rate-limit middleware exists', async () => {
    expect(await fileExists('../server/middleware/rate-limit.ts')).toBe(true)
  })

  it('cost-tracker utility exists', async () => {
    expect(await fileExists('../server/utils/cost-tracker.ts')).toBe(true)
  })

  it('log-rotator utility exists', async () => {
    expect(await fileExists('../server/utils/log-rotator.ts')).toBe(true)
  })

  it('log-rotation plugin exists', async () => {
    expect(await fileExists('../server/plugins/log-rotation.ts')).toBe(true)
  })

  it('mock-mode plugin exists', async () => {
    expect(await fileExists('../server/plugins/mock-mode.ts')).toBe(true)
  })

  it('rate-limit returns 429', async () => {
    const content = await readFile(join(__dirname, '../server/middleware/rate-limit.ts'), 'utf-8')
    expect(content).toContain('429')
    expect(content).toContain('retryAfter')
  })

  it('cost-tracker logs usage', async () => {
    const content = await readFile(join(__dirname, '../server/utils/cost-tracker.ts'), 'utf-8')
    expect(content).toContain('logCall')
    expect(content).toMatch(/promptTokens|prompt_tokens/)
  })
})
