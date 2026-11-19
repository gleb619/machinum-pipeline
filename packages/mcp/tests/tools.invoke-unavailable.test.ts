import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleToolsCall } from '../src/handlers.js'

const created: string[] = []

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('tools.invoke — missing @mt/tools', () => {
  it('notes that built-in tools are unavailable instead of crashing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mt-mcp-invoke-empty-'))
    created.push(root)
    await writeFile(join(root, 'mt.json'), `${JSON.stringify({ pipelines: [] })}\n`)

    const result = await handleToolsCall(
      {
        name: 'tools.invoke',
        arguments: { toolName: 'missing', envelope: { item: 'x' } },
      },
      root,
    )

    const text = result.content[0]?.text ?? ''
    expect(result.isError).toBe(true)
    expect(text).toContain('Unknown tool: missing')
    expect(text).toContain('built-in tools from @mt/tools are unavailable')
  })
})
