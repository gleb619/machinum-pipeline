import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverPipelines } from '../src/discovery.js'

describe('discoverPipelines error handling', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'mt-discovery-'))
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  it('returns [] when mt.json is missing', async () => {
    expect(await discoverPipelines(projectRoot)).toEqual([])
  })

  it('throws on malformed mt.json', async () => {
    await writeFile(join(projectRoot, 'mt.json'), '{ not json }')
    await expect(discoverPipelines(projectRoot)).rejects.toThrow(/Invalid mt\.json/)
  })

  it('throws when pipelines is not an array of strings', async () => {
    await writeFile(join(projectRoot, 'mt.json'), JSON.stringify({ pipelines: 'a.ts' }))
    await expect(discoverPipelines(projectRoot)).rejects.toThrow(/pipelines/)
  })

  it('skips missing listed pipeline files', async () => {
    await writeFile(join(projectRoot, 'mt.json'), JSON.stringify({ pipelines: ['./a.ts'] }))
    expect(await discoverPipelines(projectRoot)).toEqual([])
  })

  it('discovers existing pipeline files', async () => {
    await writeFile(join(projectRoot, 'mt.json'), JSON.stringify({ pipelines: ['./a.ts'] }))
    await writeFile(join(projectRoot, 'a.ts'), '')
    const result = await discoverPipelines(projectRoot)
    expect(result).toEqual([{ path: join(projectRoot, 'a.ts'), declared: './a.ts' }])
  })
})
