import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('UC-38..41 - MCP Method Registry (architectural)', () => {
  it('handlers.ts exports handleInitialize', async () => {
    const content = await readFile(join(__dirname, '../src/handlers.ts'), 'utf-8')
    expect(content).toContain('export function handleInitialize')
  })

  it('handlers.ts exports handleToolsList', async () => {
    const content = await readFile(join(__dirname, '../src/handlers.ts'), 'utf-8')
    expect(content).toContain('export function handleToolsList')
  })

  it('handlers.ts exports handleToolsCall', async () => {
    const content = await readFile(join(__dirname, '../src/handlers.ts'), 'utf-8')
    expect(content).toContain('export async function handleToolsCall')
  })

  it('handlers.ts exports handleResourcesList', async () => {
    const content = await readFile(join(__dirname, '../src/handlers.ts'), 'utf-8')
    expect(content).toContain('export async function handleResourcesList')
  })

  it('handlers.ts exports handleResourcesRead', async () => {
    const content = await readFile(join(__dirname, '../src/handlers.ts'), 'utf-8')
    expect(content).toContain('export async function handleResourcesRead')
  })

  it('handleInitialize returns server info', async () => {
    const content = await readFile(join(__dirname, '../src/handlers.ts'), 'utf-8')
    expect(content).toContain('mt-mcp')
  })

  it('handleResourcesList discovers pipelines', async () => {
    const content = await readFile(join(__dirname, '../src/handlers.ts'), 'utf-8')
    expect(content).toContain('discoverPipelines')
  })

  it('handleResourcesRead handles book URIs', async () => {
    const content = await readFile(join(__dirname, '../src/handlers.ts'), 'utf-8')
    expect(content).toContain('mt://book/')
  })

  it('handleResourcesRead handles chapter URIs', async () => {
    const content = await readFile(join(__dirname, '../src/handlers.ts'), 'utf-8')
    expect(content).toContain('mt://chapter/')
  })

  it('handleResourcesRead handles pipeline URIs', async () => {
    const content = await readFile(join(__dirname, '../src/handlers.ts'), 'utf-8')
    expect(content).toContain('mt://pipeline/')
  })

  it('handlers.ts imports from @mt/core', async () => {
    const content = await readFile(join(__dirname, '../src/handlers.ts'), 'utf-8')
    expect(content).toContain("from '@mt/core'")
  })
})
