import { execSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stripTerms } from '@mt/tools'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const SAMPLE_DIR = resolve(import.meta.dirname, '..')
const MT_BIN = join(SAMPLE_DIR, 'node_modules', '.bin', 'mt')
const CHAPTERS = join(SAMPLE_DIR, 'chapters')
const EN_DIR = join(CHAPTERS, 'en')

// Tiny synthetic chapters (not real book text).
const FIXTURE: Record<string, string> = {
  'chapter1.md': [
    '# Chapter 1: Start',
    '',
    'Arin Vale walked into the Iron Keep with Marta. Arin Vale smiled at the empty hall.',
    '',
    '"Take the [Flame Strike]," Marta said. Marta laughed at Arin Vale.',
    '',
    '[System: level up!]',
    '',
    '```',
    'Arin Vale in code',
    '```',
    '',
  ].join('\n'),
  'chapter2.md': [
    '# Chapter 2: Next',
    '',
    'The Iron Keep fell silent. Marta nodded and cast [Flame Strike] twice.',
    '',
    'They crossed the Silver River. Later the Silver River froze over in the cold.',
    '',
  ].join('\n'),
}

let hasFailure = false

async function clean(): Promise<void> {
  await mkdir(EN_DIR, { recursive: true })
  for (const f of await readdir(EN_DIR)) {
    if (f.endsWith('.md')) await rm(join(EN_DIR, f), { force: true })
  }
  await rm(join(CHAPTERS, 'schema'), { recursive: true, force: true })
  await rm(join(CHAPTERS, 'en-tagged'), { recursive: true, force: true })
  await rm(join(CHAPTERS, 'glossary.json'), { force: true })
  await rm(join(CHAPTERS, 'glossary.graph.json'), { force: true })
  await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
}

function runAnalyze(): void {
  execSync(`"${MT_BIN}" run ./pipelines/analyze.ts`, {
    cwd: SAMPLE_DIR,
    stdio: 'pipe',
    env: { ...process.env, NODE_OPTIONS: '--import tsx', MT_LLM_SUMMARY: '' },
    timeout: 30_000,
  })
}

interface GlossaryFile {
  terms: Array<{
    id: string
    term: string
    type: string
    count: number
    firstChapter: number | null
    ru: string | null
    aliases: string[]
    references?: string[]
  }>
}

interface GraphFile {
  nodes: Array<{ id: string; term: string; type: string }>
  edges: Array<{ from: string; to: string; kind: string }>
}

async function readGlossary(): Promise<GlossaryFile> {
  return JSON.parse(await readFile(join(CHAPTERS, 'glossary.json'), 'utf-8')) as GlossaryFile
}

async function readGraph(): Promise<GraphFile> {
  return JSON.parse(await readFile(join(CHAPTERS, 'glossary.graph.json'), 'utf-8')) as GraphFile
}

beforeAll(async () => {
  await clean()
  for (const [name, text] of Object.entries(FIXTURE)) {
    await writeFile(join(EN_DIR, name), text, 'utf-8')
  }
})

afterEach(({ task }) => {
  if (task.result?.state === 'fail') hasFailure = true
})

afterAll(async () => {
  if (!hasFailure) await clean()
})

describe('analyze pipeline (offline, heuristics only)', () => {
  it('runs to completion', () => {
    runAnalyze()
  })

  it('writes one heuristic summary per chapter', async () => {
    const files = (await readdir(join(CHAPTERS, 'schema'))).sort()
    expect(files).toEqual(['chapter1.summary.md', 'chapter2.summary.md'])
    const md = await readFile(join(CHAPTERS, 'schema', 'chapter1.summary.md'), 'utf-8')
    expect(md).toContain('# Chapter 1: Start')
    expect(md).toContain('Arin Vale walked into the Iron Keep')
  })

  it('writes an editable glossary with typed terms', async () => {
    const g = await readGlossary()
    const by = (term: string) => g.terms.find((t) => t.term === term)
    expect(by('Arin Vale')).toMatchObject({ id: 'arin-vale', type: 'character', ru: null })
    expect(by('Iron Keep')).toMatchObject({ type: 'place' })
    expect(by('Silver River')).toMatchObject({ type: 'place', firstChapter: 2, count: 2 })
    expect(by('[Flame Strike]')).toMatchObject({ type: 'skill', firstChapter: 1, count: 2 })
    expect(g.terms.some((t) => t.term.includes('System'))).toBe(false)
  })

  it('writes the relation graph of the terms', async () => {
    const g = await readGlossary()
    const graph = await readGraph()
    expect(graph.nodes).toHaveLength(g.terms.length)
    expect(graph.edges.length).toBeGreaterThan(0)
    const arin = g.terms.find((t) => t.term === 'Arin Vale')
    expect(arin?.references).toContain('Iron Keep')
    const edge = graph.edges.find((e) => e.from === arin?.id)
    expect(edge?.to).toBe(g.terms.find((t) => t.term === 'Iron Keep')?.id)
  })

  it('tags terms without changing the text or the line count', async () => {
    for (const [name, original] of Object.entries(FIXTURE)) {
      const tagged = await readFile(join(CHAPTERS, 'en-tagged', name), 'utf-8')
      expect(tagged).toContain('<term id=')
      expect(stripTerms(tagged)).toBe(original)
      expect(tagged.split('\n')).toHaveLength(original.split('\n').length)
    }
    const c1 = await readFile(join(CHAPTERS, 'en-tagged', 'chapter1.md'), 'utf-8')
    expect(c1).toContain('<term id="arin-vale">Arin Vale</term>')
    expect(c1).toContain('\nArin Vale in code\n')
  })

  it('keeps manual glossary edits (ru, aliases) on re-run', async () => {
    const g = await readGlossary()
    const marta = g.terms.find((t) => t.term === 'Marta')
    if (!marta) throw new Error('Marta missing')
    marta.ru = 'Марта'
    marta.aliases = ['Marty']
    await writeFile(join(CHAPTERS, 'glossary.json'), JSON.stringify(g, null, 2), 'utf-8')
    await rm(join(SAMPLE_DIR, '.mt'), { recursive: true, force: true })
    runAnalyze()
    const again = await readGlossary()
    expect(again.terms.find((t) => t.term === 'Marta')).toMatchObject({
      ru: 'Марта',
      aliases: ['Marty'],
    })
    expect(again.terms.map((t) => t.id)).toEqual(g.terms.map((t) => t.id))
  })
})
