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

describe('UC-32,34 - LLM Router Proxy (architectural)', () => {
  it('nitro.config.ts exists', async () => {
    expect(await fileExists('../nitro.config.ts')).toBe(true)
  })

  it('vitest.config.ts exists', async () => {
    expect(await fileExists('../vitest.config.ts')).toBe(true)
  })

  it('chat completions route exists', async () => {
    expect(await fileExists('../server/routes/api/chat/completions.ts')).toBe(true)
  })

  it('health route exists', async () => {
    expect(await fileExists('../server/routes/api/health.ts')).toBe(true)
  })

  it('dashboard route exists', async () => {
    expect(await fileExists('../server/routes/api/dashboard.ts')).toBe(true)
  })

  it('translate route exists', async () => {
    expect(await fileExists('../server/routes/api/translate.ts')).toBe(true)
  })

  it('chat completions route exports default function', async () => {
    const content = await readFile(
      join(__dirname, '../server/routes/api/chat/completions.ts'),
      'utf-8',
    )
    expect(content).toContain('export default')
    expect(content).toContain('poolSupplier')
    expect(content).toContain('client.apiKey')
  })

  it('router proxies to OpenRouter via pool', async () => {
    const content = await readFile(
      join(__dirname, '../server/routes/api/chat/completions.ts'),
      'utf-8',
    )
    expect(content).toContain('chat/completions')
    expect(content).toContain('client.apiUrl')
  })

  it('router uses h3 imports', async () => {
    const content = await readFile(
      join(__dirname, '../server/routes/api/chat/completions.ts'),
      'utf-8',
    )
    expect(content).toContain("from 'h3'")
    expect(content).toContain('defineEventHandler')
  })

  it('logs route exists', async () => {
    expect(await fileExists('../server/routes/api/logs.ts')).toBe(true)
  })

  it('pool route exists', async () => {
    expect(await fileExists('../server/routes/api/pool.ts')).toBe(true)
  })

  it('logs route exports default handler', async () => {
    const content = await readFile(
      join(__dirname, '../server/routes/api/logs.ts'),
      'utf-8',
    )
    expect(content).toContain('export default')
    expect(content).toContain('defineEventHandler')
  })

  it('pool route exports default handler', async () => {
    const content = await readFile(
      join(__dirname, '../server/routes/api/pool.ts'),
      'utf-8',
    )
    expect(content).toContain('export default')
    expect(content).toContain('defineEventHandler')
  })
})
