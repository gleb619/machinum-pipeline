import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dockerComposeEmitter } from '../src/core/docker-compose.js'

describe('dockerComposeEmitter', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-docker-compose-'))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  function ctxFor(root: string): ToolContext {
    return {
      run: { global: { project: { name: 'p', root } } },
    } as unknown as ToolContext
  }

  it('writes a compose file with the requested service presets', async () => {
    const tool = dockerComposeEmitter({ services: ['ollama', 'qdrant'] })

    const out = await tool.invoke(
      { id: 'ex-test', variables: [], item: undefined, meta: {} },
      ctxFor(testDir),
    )

    const content = await readFile(join(testDir, 'docker-compose.yml'), 'utf-8')
    expect(content).toContain('services:')
    expect(content).toContain('  ollama:')
    expect(content).toContain('image: ollama/ollama')
    expect(content).toContain('"11434:11434"')
    expect(content).toContain('- ollama_data:/data')
    expect(content).toContain('  qdrant:')
    expect(content).toContain('image: qdrant/qdrant')
    expect(content).toContain('"6333:6333"')
    expect(content).toContain('- qdrant_data:/data')
    expect(content).not.toContain('lightrag')

    expect(out.item).toEqual({
      path: join(testDir, 'docker-compose.yml'),
      services: ['ollama', 'qdrant'],
      include: [],
    })
    expect(getVariable(out, 'dockerCompose')).toEqual({
      path: join(testDir, 'docker-compose.yml'),
      services: ['ollama', 'qdrant'],
    })
  })

  it('renders the lightrag placeholder preset', async () => {
    const tool = dockerComposeEmitter({ services: ['lightrag'] })

    await tool.invoke({ id: 'ex-test', variables: [], item: undefined, meta: {} }, ctxFor(testDir))

    const content = await readFile(join(testDir, 'docker-compose.yml'), 'utf-8')
    expect(content).toContain('image: lightrag/lightrag')
    expect(content).toContain('"9621:9621"')
    expect(content).toContain('- lightrag_data:/data')
  })

  it('renders the include block and honours a custom outPath', async () => {
    const tool = dockerComposeEmitter({
      outPath: './deploy/compose.yml',
      services: ['ollama'],
      include: ['./base.yml', './extra/monitoring.yml'],
    })
    await mkdir(join(testDir, 'deploy'), { recursive: true })

    const out = await tool.invoke(
      { id: 'ex-test', variables: [], item: undefined, meta: {} },
      ctxFor(testDir),
    )

    const content = await readFile(join(testDir, 'deploy', 'compose.yml'), 'utf-8')
    expect(content).toContain('include:')
    expect(content).toContain('  - ./base.yml')
    expect(content).toContain('  - ./extra/monitoring.yml')
    expect(out.item.path).toBe(join(testDir, 'deploy', 'compose.yml'))
  })

  it('writes atomically (no temp sibling left behind)', async () => {
    const tool = dockerComposeEmitter({ services: ['ollama'] })

    await tool.invoke({ id: 'ex-test', variables: [], item: undefined, meta: {} }, ctxFor(testDir))

    expect(await readdir(testDir)).toEqual(['docker-compose.yml'])
  })
})
