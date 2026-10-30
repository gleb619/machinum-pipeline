import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleResourcesList } from '../src/handlers.js'

describe('handleResourcesList errors reach the MCP layer', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'mt-mcp-'))
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  it('throws descriptive error on malformed mt.json', async () => {
    await writeFile(join(projectRoot, 'mt.json'), '{ bad }')
    await expect(handleResourcesList(projectRoot)).rejects.toThrow(/Invalid mt\.json/)
  })

  it('throws when pipelines is not a string array', async () => {
    await writeFile(join(projectRoot, 'mt.json'), JSON.stringify({ pipelines: 123 }))
    await expect(handleResourcesList(projectRoot)).rejects.toThrow(/pipelines/)
  })
})
