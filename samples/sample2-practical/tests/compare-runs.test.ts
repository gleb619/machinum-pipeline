import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BackupMeta } from '../scripts/backup-run.js'
import { compareRuns } from '../scripts/compare-runs.js'
import type { TimingsRecord } from '../scripts/run-book.js'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mt-compare-'))
  roots.push(root)
  return root
}

const EN_ONE = '# Chapter One\n\nHello world.\n\nGoodbye moon.\n'
const RU_ONE = '# Глава один\n\nПривет мир.\n\nПрощай луна.\n'
const EN_TWO = '# Chapter Two\n\nThe rain falls.\n\nA cat sleeps.\n'

function meta(label: string, counts: BackupMeta['counts'] = { en: 2, ru: 2 }): BackupMeta {
  return {
    label,
    createdAt: '2026-01-01T00:00:00.000Z',
    gitHead: 'abc1234567',
    gitDirty: false,
    resolved: { tool: 'mock', model: 'mock', perStage: { summary: 'mock' } },
    knobs: {},
    counts,
    missing: [],
  }
}

function timings(label: string): TimingsRecord {
  return {
    label,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:10.000Z',
    stages: {
      en: { ms: 1000, status: 'ok', exitCode: 0 },
      chapters: { ms: 4000, status: 'ok', exitCode: 0 },
    },
    totalMs: 5000,
  }
}

interface Fixture {
  chapter2Ru: string
}

async function makeRun(root: string, name: string, fixture: Fixture): Promise<string> {
  const dir = join(root, name)
  await mkdir(join(dir, 'chapters/en'), { recursive: true })
  await mkdir(join(dir, 'chapters/ru'), { recursive: true })
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta(name)))
  await writeFile(join(dir, 'timings.json'), JSON.stringify(timings(name)))
  await writeFile(join(dir, 'chapters/en/chapter1.md'), EN_ONE)
  await writeFile(join(dir, 'chapters/ru/chapter1.md'), RU_ONE)
  await writeFile(join(dir, 'chapters/en/chapter2.md'), EN_TWO)
  await writeFile(join(dir, 'chapters/ru/chapter2.md'), fixture.chapter2Ru)
  return dir
}

interface CountsFixture {
  en: string[]
  ru: string[]
  meta?: BackupMeta
}

const NAMES = {
  _comment: 'fixture',
  people: {
    Nadia: { ru: 'Надя', gen: 'Нади', type: 'character' },
    Fiona: { ru: 'Файона', gen: 'Файоны', type: 'character' },
  },
}

const EN_NAMES = '# Chapter\n\nOne.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n\nSix.\n'

/** One chapter whose RU paragraphs exercise pinned inflections and drifting name forms. */
async function makeNamesRun(root: string, name: string, ru: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(join(dir, 'chapters/en'), { recursive: true })
  await mkdir(join(dir, 'chapters/ru'), { recursive: true })
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta(name, { en: 1, ru: 1 })))
  await writeFile(join(dir, 'chapters/names.json'), JSON.stringify(NAMES))
  await writeFile(join(dir, 'chapters/en/chapter1.md'), EN_NAMES)
  await writeFile(join(dir, 'chapters/ru/chapter1.md'), ru)
  return dir
}

/** Write a run directory with the given chapter files and an optional `meta.json`. */
async function makeCountsRun(root: string, name: string, fixture: CountsFixture): Promise<string> {
  const dir = join(root, name)
  await mkdir(join(dir, 'chapters/en'), { recursive: true })
  await mkdir(join(dir, 'chapters/ru'), { recursive: true })
  if (fixture.meta) await writeFile(join(dir, 'meta.json'), JSON.stringify(fixture.meta))
  for (const [index, text] of fixture.en.entries()) {
    await writeFile(join(dir, 'chapters/en', `chapter${index + 1}.md`), text)
  }
  for (const [index, text] of fixture.ru.entries()) {
    await writeFile(join(dir, 'chapters/ru', `chapter${index + 1}.md`), text)
  }
  return dir
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('compareRuns', () => {
  it('reports a dropped line and a foreign-script hit in run B', async () => {
    const root = await makeRoot()
    const a = await makeRun(root, 'a', { chapter2Ru: '# Глава два\n\nДождь идёт.\n\nКот спит.\n' })
    const b = await makeRun(root, 'b', {
      chapter2Ru: '# Глава два <terms x>\n\nДождь 木板 идёт.\n',
    })

    const result = await compareRuns({ a, b })
    const out = join(root, 'report.md')
    await writeFile(out, result.markdown, 'utf-8')

    expect(result.defects.a.hard).toBe(0)
    expect(result.defects.b.parityErrors).toBeGreaterThanOrEqual(1)
    expect(result.defects.b.foreignScript).toBeGreaterThanOrEqual(1)
    expect(result.defects.b.metadataLeaks).toBeGreaterThanOrEqual(1)
    expect(result.defects.total).toBeGreaterThan(0)

    expect(result.markdown).toContain('# Run comparison: a vs b')
    expect(result.markdown).toContain('chapter 2')
    expect(result.markdown).toContain('line-count')
    expect(result.markdown).toContain('quality winner')

    const written = await readFile(out, 'utf-8')
    expect(written).toContain('## Verdict')
  })

  it('prints the real EN and RU chapter counts', async () => {
    const root = await makeRoot()
    const a = await makeCountsRun(root, 'with-meta', {
      en: [EN_ONE, EN_TWO],
      ru: [RU_ONE],
      meta: meta('with-meta', { en: 2, ru: 1 }),
    })
    const b = await makeCountsRun(root, 'no-meta', { en: [EN_ONE, EN_TWO], ru: [RU_ONE] })

    const result = await compareRuns({ a, b })

    expect(result.markdown).toContain('| chapters (EN / RU) | 2 / 1 | 2 / 1 |')
  })

  it('stays clean when the two runs are identical', async () => {
    const root = await makeRoot()
    const fixture = { chapter2Ru: '# Глава два\n\nДождь идёт.\n\nКот спит.\n' }
    const a = await makeRun(root, 'same-a', fixture)
    const b = await makeRun(root, 'same-b', fixture)

    const result = await compareRuns({ a, b })

    expect(result.defects.a.hard).toBe(0)
    expect(result.defects.b.hard).toBe(0)
    expect(result.defects.total).toBe(0)
  })

  it('names the pinned inflections and reports drifting name variants', async () => {
    const root = await makeRoot()
    const drifting = await makeNamesRun(
      root,
      'drift',
      '# Глава\n\nНадя пришла.\n\nНаде сказали.\n\nНади нет.\n\nНадия пришла.\n\nНадия ушла.\n\nФиона спала.\n',
    )
    const clean = await makeNamesRun(
      root,
      'clean',
      '# Глава\n\nНадя пришла.\n\nНаде сказали.\n\nНади нет.\n\nДождь идёт.\n\nКот спит.\n\nМышь бежит.\n',
    )

    const result = await compareRuns({ a: drifting, b: clean })

    expect(result.markdown).toContain('## Names')
    expect(result.markdown).toContain('Надия')
    expect(result.markdown).toContain('Фиона')
    expect(result.markdown).not.toContain('Наде →')
    expect(result.markdown).not.toContain('Нади →')
    expect(result.markdown).toContain('names: 2 table name(s), 2 pinned hits, 3 variant hits')
    expect(result.markdown).toContain('names: 1 table name(s), 2 pinned hits, 0 variant hits')
    expect(result.markdown).toContain('quality winner: **clean**')
    expect(result.defects.total).toBe(0)

    const cleanResult = await compareRuns({ a: clean, b: clean })
    expect(cleanResult.markdown).toContain('No name variants in either run.')
    expect(cleanResult.markdown).toContain('names: 1 table name(s), 2 pinned hits, 0 variant hits')
  })
})
