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

describe('UC-37 - MCP Server (architectural)', () => {
  it('vitest.config.ts exists', async () => {
    expect(await fileExists('../vitest.config.ts')).toBe(true)
  })

  it('server.ts exists', async () => {
    expect(await fileExists('../src/server.ts')).toBe(true)
  })

  it('handlers.ts exists', async () => {
    expect(await fileExists('../src/handlers.ts')).toBe(true)
  })

  it('server.ts exports startMcpServer', async () => {
    const content = await readFile(join(__dirname, '../src/server.ts'), 'utf-8')
    expect(content).toContain('export async function startMcpServer')
  })

  it('server.ts uses node:readline', async () => {
    const content = await readFile(join(__dirname, '../src/server.ts'), 'utf-8')
    expect(content).toContain("from 'node:readline'")
  })

  it('server.ts handles initialize method', async () => {
    const content = await readFile(join(__dirname, '../src/server.ts'), 'utf-8')
    expect(content).toContain("case 'initialize'")
  })

  it('server.ts handles tools/list', async () => {
    const content = await readFile(join(__dirname, '../src/server.ts'), 'utf-8')
    expect(content).toContain("case 'tools/list'")
  })

  it('server.ts handles tools/call', async () => {
    const content = await readFile(join(__dirname, '../src/server.ts'), 'utf-8')
    expect(content).toContain("case 'tools/call'")
  })

  it('server.ts handles resources/list', async () => {
    const content = await readFile(join(__dirname, '../src/server.ts'), 'utf-8')
    expect(content).toContain("case 'resources/list'")
  })

  it('server.ts handles resources/read', async () => {
    const content = await readFile(join(__dirname, '../src/server.ts'), 'utf-8')
    expect(content).toContain("case 'resources/read'")
  })

  it('server.ts writes JSON-RPC 2.0 responses', async () => {
    const content = await readFile(join(__dirname, '../src/server.ts'), 'utf-8')
    expect(content).toContain("jsonrpc: '2.0'")
  })

  it('server.ts handles parse errors', async () => {
    const content = await readFile(join(__dirname, '../src/server.ts'), 'utf-8')
    expect(content).toContain('-32700')
  })
})
