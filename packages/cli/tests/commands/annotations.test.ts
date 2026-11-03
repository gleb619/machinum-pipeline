import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetAnnotationRegistry } from '@mt/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { annotationsCommand } from '../../src/commands/annotations.js'

const PIPELINE = `
import { annotate, annotationsOf, tool, useCase, waypoint } from '@mt/core'

annotate(
  { name: 'zeta-tool' },
  tool('TL002', { name: 'Zeta', description: 'Second tool', refs: ['UC002', 'UC001'] }),
)
const alpha = annotate(
  { name: 'alpha-tool' },
  tool('TL001', { name: 'Alpha', description: 'First tool', refs: ['UC001'] }),
)
if (annotationsOf(alpha).length !== 1) throw new Error('fixture annotation missing')
// Same kind + id + targetName as above: mt annotations must dedupe it.
annotate(
  { name: 'alpha-tool' },
  tool('TL001', { name: 'Alpha', description: 'First tool', refs: ['UC001'] }),
)
annotate(
  { name: 'list-annotations' },
  useCase('UC001', { name: 'List annotations', description: 'List them' }),
)
annotate(
  { uri: 'jsonl://' },
  waypoint('WT001', { name: 'JSONL', description: 'JSON lines' }),
)

export default { id: 'annotations-fixture' }
`

interface JsonRow {
  kind: string
  id: string
  name: string
  description: string
  refs: string[]
  targetName: string
}

describe('annotations command', () => {
  let testDir: string
  let originalCwd: string
  let stdout: string
  let stderr: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mt-annotations-test-'))
    originalCwd = process.cwd()
    process.chdir(testDir)
    await writeFile(join(testDir, 'pipeline.ts'), PIPELINE)

    resetAnnotationRegistry()
    stdout = ''
    stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      stdout += `${a.join(' ')}\n`
    })
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      stderr += `${a.join(' ')}\n`
    })
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`)
    })
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    resetAnnotationRegistry()
    vi.restoreAllMocks()
    await rm(testDir, { recursive: true, force: true })
  })

  it('prints a table with KIND ID NAME REFS DESCRIPTION, sorted and deduped', async () => {
    await annotationsCommand(['pipeline.ts'])

    expect(stdout).toContain('KIND')
    expect(stdout).toContain('ID')
    expect(stdout).toContain('NAME')
    expect(stdout).toContain('REFS')
    expect(stdout).toContain('DESCRIPTION')

    const rows = stdout
      .split('\n')
      .filter((line) => /^(tool|useCase|waypoint)\s/.test(line))
      .map((line) => line.split(/\s+/).slice(0, 2).join(' '))

    expect(rows).toEqual(['tool TL001', 'tool TL002', 'useCase UC001', 'waypoint WT001'])
    expect(stdout).toContain('First tool')
    expect(stdout).toContain('JSON lines')
    expect(stdout).not.toContain('No annotations registered.')
  })

  it('prints JSON with the record shape', async () => {
    await annotationsCommand(['pipeline.ts', '--json'])

    const rows = JSON.parse(stdout) as JsonRow[]
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => `${row.kind}:${row.id}:${row.targetName}`)).toEqual([
      'tool:TL001:alpha-tool',
      'tool:TL002:zeta-tool',
      'useCase:UC001:list-annotations',
      'waypoint:WT001:jsonl://',
    ])
    expect(rows[0]).toEqual({
      kind: 'tool',
      id: 'TL001',
      name: 'Alpha',
      description: 'First tool',
      refs: ['UC001'],
      targetName: 'alpha-tool',
    })
  })

  it('filters by --kind', async () => {
    await annotationsCommand(['pipeline.ts', '--kind', 'tool', '--json'])

    const rows = JSON.parse(stdout) as JsonRow[]
    expect(rows.map((row) => row.id)).toEqual(['TL001', 'TL002'])
    expect(rows.every((row) => row.kind === 'tool')).toBe(true)
  })

  it('accepts --kind=<kind>', async () => {
    await annotationsCommand(['pipeline.ts', '--kind=useCase', '--json'])

    const rows = JSON.parse(stdout) as JsonRow[]
    expect(rows.map((row) => row.id)).toEqual(['UC001'])
  })

  it('rejects an unknown --kind with stderr and exit 1', async () => {
    await expect(annotationsCommand(['pipeline.ts', '--kind', 'nope'])).rejects.toThrow('exit:1')
    expect(stderr).toContain("Unknown annotation kind 'nope'")
    expect(stdout).toBe('')
  })

  it('reports an empty registry clearly and exits 0', async () => {
    await annotationsCommand([])

    expect(stdout).toBe('No annotations registered.\n')
    expect(stderr).toBe('')
  })

  it('prints usage for --help', async () => {
    await annotationsCommand(['--help'])

    expect(stdout).toContain('Usage: mt annotations')
    expect(stdout).toContain('--kind <kind>')
    expect(stderr).toBe('')
  })

  it('emits an empty JSON array when nothing is registered', async () => {
    await annotationsCommand(['--json'])

    expect(JSON.parse(stdout)).toEqual([])
  })
})
