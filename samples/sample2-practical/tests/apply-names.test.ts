import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyNames } from '../scripts/apply-names.js'

interface OutTerm {
  id?: string
  term: string
  type?: string
  ru?: string | null
  count?: number
  firstChapter?: number | null
  aliases?: string[]
  references?: string[]
  ignored?: boolean
}

interface OutGlossary {
  terms: OutTerm[]
}

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mt-apply-names-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function term(overrides: Partial<OutTerm> & { term: string }): OutTerm {
  return {
    id: overrides.term.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    type: 'term',
    count: 1,
    firstChapter: 1,
    ru: null,
    aliases: [],
    references: [],
    ...overrides,
  }
}

async function writeFixture(
  root: string,
  glossary: OutGlossary,
  names?: unknown,
): Promise<{ glossaryPath: string; namesPath: string }> {
  const glossaryPath = join(root, 'glossary.json')
  const namesPath = join(root, 'names.json')
  await writeFile(glossaryPath, `${JSON.stringify(glossary, null, 2)}\n`)
  if (names !== undefined) await writeFile(namesPath, `${JSON.stringify(names, null, 2)}\n`)
  return { glossaryPath, namesPath }
}

async function readGlossary(path: string): Promise<OutGlossary> {
  return JSON.parse(await readFile(path, 'utf-8')) as OutGlossary
}

function byTerm(glossary: OutGlossary): Map<string, OutTerm> {
  return new Map(glossary.terms.map((entry) => [entry.term, entry]))
}

describe('applyNames', () => {
  it('pins table names, uses the genitive for possessives and ignores non-names', async () => {
    const root = await makeRoot()
    const { glossaryPath, namesPath } = await writeFixture(
      root,
      {
        terms: [term({ term: 'Nadia' }), term({ term: "Nadia's" }), term({ term: 'Lock' })],
      },
      {
        _comment: 'not a name group',
        people: { Nadia: { ru: 'Надя', gen: 'Нади', type: 'character' } },
      },
    )

    const result = await applyNames({ glossaryPath, namesPath, log: () => {} })

    expect(result).toEqual({ rewritten: 2, ignored: 1, added: 0, applied: 1, changed: true })
    const terms = byTerm(await readGlossary(glossaryPath))
    expect(terms.get('Nadia')?.ru).toBe('Надя')
    expect(terms.get('Nadia')?.type).toBe('character')
    expect(terms.get('Nadia')?.ignored).toBeUndefined()
    expect(terms.get("Nadia's")?.ru).toBe('Нади')
    expect(terms.get("Nadia's")?.type).toBe('character')
    expect(terms.get('Lock')?.ignored).toBe(true)
    expect(terms.get('Lock')?.ru).toBeNull()
  })

  it('strips trailing punctuation before matching', async () => {
    const root = await makeRoot()
    const { glossaryPath, namesPath } = await writeFixture(
      root,
      { terms: [term({ term: 'Nadia,' }), term({ term: 'Nadia’s.' })] },
      { people: { Nadia: { ru: 'Надя', gen: 'Нади', type: 'character' } } },
    )

    const result = await applyNames({ glossaryPath, namesPath, log: () => {} })

    expect(result).toMatchObject({ rewritten: 2, ignored: 0, added: 0 })
    const terms = byTerm(await readGlossary(glossaryPath))
    expect(terms.get('Nadia,')?.ru).toBe('Надя')
    expect(terms.get('Nadia’s.')?.ru).toBe('Нади')
  })

  it('creates a table name the extractor missed with count 0', async () => {
    const root = await makeRoot()
    const { glossaryPath, namesPath } = await writeFixture(
      root,
      { terms: [term({ term: 'Nadia' })] },
      {
        people: {
          Nadia: { ru: 'Надя', gen: 'Нади', type: 'character' },
          Emeka: { ru: 'Эмека', gen: 'Эмеки', type: 'character' },
        },
      },
    )

    const result = await applyNames({ glossaryPath, namesPath, log: () => {} })

    expect(result).toEqual({ rewritten: 1, ignored: 0, added: 1, applied: 2, changed: true })
    const emeka = byTerm(await readGlossary(glossaryPath)).get('Emeka')
    expect(emeka).toMatchObject({
      id: 'emeka',
      term: 'Emeka',
      type: 'character',
      count: 0,
      firstChapter: null,
      ru: 'Эмека',
      aliases: [],
      references: [],
    })
    expect(emeka?.ignored).toBeUndefined()
  })

  it('is idempotent and --dry-run writes nothing', async () => {
    const names = {
      people: {
        Nadia: { ru: 'Надя', gen: 'Нади', type: 'character' },
        Emeka: { ru: 'Эмека', gen: 'Эмеки', type: 'character' },
      },
    }
    const root = await makeRoot()
    const { glossaryPath, namesPath } = await writeFixture(
      root,
      { terms: [term({ term: 'Nadia' }), term({ term: 'Lock' })] },
      names,
    )

    const first = await applyNames({ glossaryPath, namesPath, log: () => {} })
    expect(first.changed).toBe(true)
    const afterFirst = await readFile(glossaryPath, 'utf-8')

    const second = await applyNames({ glossaryPath, namesPath, log: () => {} })
    expect(second).toEqual({ rewritten: 0, ignored: 0, added: 0, applied: 2, changed: false })
    expect(await readFile(glossaryPath, 'utf-8')).toBe(afterFirst)

    const dryRoot = await makeRoot()
    const dry = await writeFixture(dryRoot, { terms: [term({ term: 'Nadia' })] }, names)
    const beforeDry = await readFile(dry.glossaryPath, 'utf-8')
    const dryResult = await applyNames({
      glossaryPath: dry.glossaryPath,
      namesPath: dry.namesPath,
      dryRun: true,
      log: () => {},
    })
    expect(dryResult.changed).toBe(true)
    expect(await readFile(dry.glossaryPath, 'utf-8')).toBe(beforeDry)
  })

  it('reports missing and invalid files with a readable message', async () => {
    const root = await makeRoot()
    const missing = join(root, 'nope.json')
    const valid = await writeFixture(root, { terms: [] }, { people: {} })

    await expect(applyNames({ glossaryPath: missing, namesPath: valid.namesPath })).rejects.toThrow(
      /glossary file not found/,
    )
    await expect(
      applyNames({ glossaryPath: valid.glossaryPath, namesPath: missing }),
    ).rejects.toThrow(/names file not found/)

    const badGlossary = join(root, 'bad-glossary.json')
    await writeFile(badGlossary, '{"terms": "nope"}\n')
    await expect(
      applyNames({ glossaryPath: badGlossary, namesPath: valid.namesPath }),
    ).rejects.toThrow(/failed to parse glossary/)

    const badNames = join(root, 'bad-names.json')
    await writeFile(badNames, 'not json\n')
    await expect(
      applyNames({ glossaryPath: valid.glossaryPath, namesPath: badNames }),
    ).rejects.toThrow(/failed to parse names/)
  })
})
