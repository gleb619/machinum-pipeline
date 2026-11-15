import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BOOK_STAGES,
  type TimingsRecord,
  runBook,
  selectStages,
  writeTimings,
} from '../scripts/run-book.js'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mt-run-book-'))
  roots.push(root)
  return root
}

async function readTimings(dir: string): Promise<TimingsRecord> {
  return JSON.parse(await readFile(join(dir, 'timings.json'), 'utf-8')) as TimingsRecord
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('selectStages', () => {
  it('defaults to the full canonical chain', () => {
    expect(selectStages()).toEqual([...BOOK_STAGES])
  })

  it('keeps canonical order for --stages', () => {
    expect(selectStages({ stages: 'stats,en' })).toEqual(['en', 'stats'])
  })

  it('removes --skip stages, including after --stages', () => {
    expect(selectStages({ skip: 'en,stats' })).not.toContain('en')
    expect(selectStages({ skip: 'en,stats' })).not.toContain('stats')
    expect(selectStages({ stages: 'en,stats,split', skip: 'stats' })).toEqual(['en', 'split'])
  })

  it('rejects an unknown stage', () => {
    expect(() => selectStages({ stages: 'en,nope' })).toThrow(/unknown stage 'nope'/)
  })
})

describe('writeTimings', () => {
  it('replaces the previous record atomically', async () => {
    const root = await makeRoot()
    const dir = join(root, 'runs', 'x')
    const first: TimingsRecord = {
      label: 'x',
      startedAt: '2026-01-01T00:00:00.000Z',
      stages: { en: { ms: 10, status: 'ok', exitCode: 0 } },
      totalMs: 10,
    }
    await writeTimings(dir, first)
    const second: TimingsRecord = {
      ...first,
      finishedAt: '2026-01-01T00:00:01.000Z',
      stages: { en: { ms: 99, status: 'failed', exitCode: 1 } },
      totalMs: 99,
      failedStage: 'en',
    }
    await writeTimings(dir, second)

    const record = await readTimings(dir)
    expect(record.stages.en?.ms).toBe(99)
    expect(record.failedStage).toBe('en')
    expect(record.stages.stats).toBeUndefined()
  })
})

describe('runBook', () => {
  it('records the timings shape and stops the chain on the first failure', async () => {
    const root = await makeRoot()
    const calls: string[] = []
    const result = await runBook({
      label: 'fake',
      root,
      stages: 'en,stats,split',
      noBackup: true,
      checkBackend: false,
      log: () => {},
      runStage: async (stage) => {
        calls.push(stage)
        return stage === 'stats' ? 1 : 0
      },
    })

    expect(calls).toEqual(['en', 'stats'])
    expect(result.timings.label).toBe('fake')
    expect(result.timings.failedStage).toBe('stats')
    expect(result.timings.finishedAt).toBeTruthy()
    expect(typeof result.timings.totalMs).toBe('number')

    const record = await readTimings(join(root, 'runs', 'fake'))
    expect(record.stages.en?.status).toBe('ok')
    expect(record.stages.stats?.status).toBe('failed')
    expect(record.stages.stats?.exitCode).toBe(1)
    expect(record.stages.split?.status).toBe('skipped')
    expect(record.stages.split?.exitCode).toBeNull()
  })

  it('runs every selected stage when all exit 0', async () => {
    const root = await makeRoot()
    const calls: string[] = []
    const result = await runBook({
      label: 'clean',
      root,
      stages: 'en,stats',
      noBackup: true,
      checkBackend: false,
      log: () => {},
      runStage: async (stage) => {
        calls.push(stage)
        return 0
      },
    })

    expect(calls).toEqual(['en', 'stats'])
    expect(result.timings.failedStage).toBeUndefined()
    expect(result.timings.stages.en?.status).toBe('ok')
  })

  it('applies the names table after a successful glossary stage', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'chapters'), { recursive: true })
    await writeFile(
      join(root, 'chapters', 'glossary.json'),
      JSON.stringify({
        terms: [
          {
            id: 'nadia',
            term: 'Nadia',
            type: 'character',
            count: 1,
            firstChapter: 1,
            ru: null,
            aliases: [],
            references: [],
          },
          {
            id: 'lock',
            term: 'Lock',
            type: 'term',
            count: 1,
            firstChapter: 1,
            ru: null,
            aliases: [],
            references: [],
          },
        ],
      }),
    )
    await writeFile(
      join(root, 'chapters', 'names.json'),
      JSON.stringify({ people: { Nadia: { ru: 'Надя', gen: 'Нади', type: 'character' } } }),
    )

    const lines: string[] = []
    await runBook({
      label: 'glossary',
      root,
      stages: 'glossary',
      noBackup: true,
      checkBackend: false,
      log: (line) => lines.push(line),
      runStage: async () => 0,
    })

    expect(lines).toContain('stage=glossary names-applied=1 ignored=1')
    const glossary = JSON.parse(
      await readFile(join(root, 'chapters', 'glossary.json'), 'utf-8'),
    ) as { terms: Array<{ term: string; ru: string | null; ignored?: boolean }> }
    expect(glossary.terms.find((entry) => entry.term === 'Nadia')?.ru).toBe('Надя')
    expect(glossary.terms.find((entry) => entry.term === 'Lock')?.ignored).toBe(true)
  })

  it('logs names-applied=0 when the names table is missing', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'chapters'), { recursive: true })
    await writeFile(join(root, 'chapters', 'glossary.json'), '{"terms":[]}\n')

    const lines: string[] = []
    await runBook({
      label: 'no-names',
      root,
      stages: 'glossary',
      noBackup: true,
      checkBackend: false,
      log: (line) => lines.push(line),
      runStage: async () => 0,
    })

    expect(lines).toContain('stage=glossary names-applied=0')
  })
})
