import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { stripTerms } from '@mt/tools'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAPTERS, SAMPLE_DIR, clean, run, writeJsonl } from './helpers.js'

const EN_DIR = join(CHAPTERS, 'en')
const TAGGED_DIR = join(CHAPTERS, 'en-tagged')
const SCHEMA_DIR = join(CHAPTERS, 'schema')
const GLOSSARY = join(CHAPTERS, 'glossary.json')
const WAYPOINT_LOG = join(CHAPTERS, 'waypoint-log.jsonl')
const INPUT = join(SAMPLE_DIR, 'jsonl', 'input.jsonl')

const RAW = [
  {
    key: 'fixture/chapter-1',
    value:
      'Chapter 1: First Light\n“Arin Vale” stepped into the Iron Keep… the hall was empty .\n[System: level up!]\n\nArin Vale smiled at Marta​.',
  },
  {
    key: 'fixture/chapter-2',
    value:
      'Chapter 2: Second Wind\nThe Iron Keep fell. Marta nodded at Arin Vale.\n* * *\nSilver River froze over ,cold.',
  },
]

let hasFailure = false

async function mdFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((file) => file.endsWith('.md')).sort()
}

async function cleanup(): Promise<void> {
  await clean(
    EN_DIR,
    TAGGED_DIR,
    SCHEMA_DIR,
    GLOSSARY,
    WAYPOINT_LOG,
    join(CHAPTERS, 'glossary.graph.json'),
    INPUT,
    join(SAMPLE_DIR, '.mt'),
  )
}

beforeAll(async () => {
  await cleanup()
  await writeJsonl(INPUT, RAW)
  run('pipe07-normalize-analyze.ts')
}, 60_000)

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await cleanup()
})

describe('pipe07 normalize', () => {
  it('writes one clean chapter per raw record', async () => {
    expect(await mdFiles(EN_DIR)).toEqual(['chapter1.md', 'chapter2.md'])
    const first = await readFile(join(EN_DIR, 'chapter1.md'), 'utf-8')
    expect(first.startsWith('# Chapter 1: First Light\n')).toBe(true)
    expect(first).toContain('"Arin Vale" stepped into the Iron Keep... the hall was empty.')
    expect(first).not.toMatch(/[“”…​]/)
    expect(first).toContain('[System: level up!]')
  })

  it('keeps every paragraph line and drops decorative rules', async () => {
    const first = await readFile(join(EN_DIR, 'chapter1.md'), 'utf-8')
    const lines = first.split('\n').filter((line) => line.trim() !== '')
    expect(lines).toHaveLength(4) // heading + 3 body lines
    const second = await readFile(join(EN_DIR, 'chapter2.md'), 'utf-8')
    expect(second).not.toContain('* * *')
  })
})

describe('pipe07 analyze', () => {
  it('writes one heuristic summary per chapter', async () => {
    expect(await mdFiles(SCHEMA_DIR)).toEqual(['chapter1.summary.md', 'chapter2.summary.md'])
    const summary = await readFile(join(SCHEMA_DIR, 'chapter1.summary.md'), 'utf-8')
    expect(summary).toContain('# Chapter 1: First Light')
    expect(summary).toContain('## Summary')
  })

  it('writes an editable glossary with heuristically typed terms', async () => {
    const glossary = JSON.parse(await readFile(GLOSSARY, 'utf-8')) as {
      terms: Array<{ id: string; term: string; type: string; ru: string | null }>
    }
    const byTerm = (term: string) => glossary.terms.find((entry) => entry.term === term)
    expect(byTerm('Arin Vale')).toMatchObject({ id: 'arin-vale', type: 'character', ru: null })
    expect(byTerm('Iron Keep')).toMatchObject({ type: 'place' })
    expect(byTerm('Silver River')).toMatchObject({ type: 'place' })
  })

  it('tags terms without changing the text or the line count', async () => {
    for (const [name, original] of [
      ['chapter1.md', await readFile(join(EN_DIR, 'chapter1.md'), 'utf-8')],
      ['chapter2.md', await readFile(join(EN_DIR, 'chapter2.md'), 'utf-8')],
    ] as const) {
      const tagged = await readFile(join(TAGGED_DIR, name), 'utf-8')
      expect(tagged).toContain('<term id=')
      expect(stripTerms(tagged)).toBe(original)
      expect(tagged.split('\n')).toHaveLength(original.split('\n').length)
    }
    const first = await readFile(join(TAGGED_DIR, 'chapter1.md'), 'utf-8')
    expect(first).toContain('<term id="arin-vale">Arin Vale</term>')
  })
})

describe('pipe07 defineWaypoint audit log', () => {
  it('logs source/target lifecycle events and skips an empty chapter', async () => {
    await clean(EN_DIR, WAYPOINT_LOG, INPUT, join(SAMPLE_DIR, '.mt'))
    await writeJsonl(INPUT, [
      { key: 'fixture/chapter-1', value: 'Chapter 1: First Light\n“Hello,” she said… it’s fine .' },
      { key: 'fixture/chapter-2', value: 'Chapter 2: Second Wind\nOne – two—three.' },
      { key: 'fixture/chapter-3', value: '' },
    ])
    run('pipe07-normalize-analyze.ts', { pipeline: 'waypointLogPipeline' })

    expect((await readdir(EN_DIR)).filter((file) => file.endsWith('.md')).sort()).toEqual([
      'chapter1.md',
      'chapter2.md',
    ])
    const events = (await readFile(WAYPOINT_LOG, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; key?: string; skipped?: number })
    expect(events.filter((event) => event.event === 'source:start')).toHaveLength(1)
    expect(events.filter((event) => event.event === 'source:item')).toHaveLength(2)
    expect(events.filter((event) => event.event === 'source:skip')).toHaveLength(1)
    expect(events.find((event) => event.event === 'source:skip')?.key).toBe('fixture/chapter-3')
    expect(events.filter((event) => event.event === 'target:write')).toHaveLength(2)
    expect(events.at(-1)?.event).toBe('target:close')
    expect(events.at(-1)?.skipped).toBe(1)
  })
})
