import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { exchangeOf } from './exchange-helper.js'

import { parseGlossary, serializeGlossary } from '../src/normalization/glossary-extractor.js'
import {
  buildStatDict,
  defineStatDict,
  selectStatDictCandidates,
  statDict,
} from '../src/normalization/stat-dict.js'
import { buildStatFreqReport } from '../src/normalization/stat-freq.js'
import type { Glossary } from '../src/normalization/term-tagger.js'

const CTX = {} as ToolContext

const TEXT =
  'Cat sat on the mat. Cat sat on the mat. Cat sat on the mat. Dogs bark loudly. Silver sword gleamed.'
const REPORT = buildStatFreqReport([TEXT])

const EXISTING: Glossary = {
  terms: [
    {
      id: 'cat',
      term: 'Cat',
      type: 'character',
      count: 12,
      firstChapter: 1,
      ru: 'Кот',
      aliases: ['Кот'],
    },
    {
      id: 'silver-sword',
      term: 'Silver Sword',
      type: 'item',
      count: 4,
      firstChapter: 2,
      ru: 'Серебряный меч',
      aliases: [],
    },
  ],
  ignored: ['mat'],
}

describe('selectStatDictCandidates', () => {
  it('keeps only the terms at or above the threshold', () => {
    const candidates = selectStatDictCandidates(REPORT, { minCount: 3 })
    expect(candidates.map((c) => c.term)).toEqual(['cat', 'cat sat', 'mat', 'sat'])
    expect(candidates.every((c) => c.count >= 3)).toBe(true)
  })

  it('ranks by count desc, then term asc', () => {
    const candidates = selectStatDictCandidates(REPORT, { minCount: 1 })
    const counts = candidates.map((c) => c.count)
    expect([...counts].sort((a, b) => b - a)).toEqual(counts)
    expect(candidates[0]).toEqual({ term: 'cat', count: 3, kind: 'word' })
    expect(candidates.find((c) => c.term === 'dogs')).toEqual({
      term: 'dogs',
      count: 1,
      kind: 'word',
    })
  })

  it('caps the candidate list at topK', () => {
    expect(selectStatDictCandidates(REPORT, { minCount: 1, topK: 3 })).toHaveLength(3)
  })

  it('lists every term once, even when it is in several lists', () => {
    const candidates = selectStatDictCandidates(REPORT, { minCount: 1 })
    const terms = candidates.map((c) => c.term)
    expect(new Set(terms).size).toBe(terms.length)
  })
})

describe('buildStatDict', () => {
  it('keeps the existing entries verbatim and appends the new candidates', () => {
    const merged = buildStatDict(REPORT, EXISTING, { minCount: 3 })
    expect(merged.terms[0]).toEqual(EXISTING.terms[0])
    expect(merged.terms[1]).toEqual(EXISTING.terms[1])
    expect(merged.terms.map((t) => t.term)).toEqual(['Cat', 'Silver Sword', 'cat sat', 'sat'])
  })

  it('never renames, re-types or re-translates an existing term', () => {
    const merged = buildStatDict(REPORT, EXISTING, { minCount: 1 })
    const cat = merged.terms.find((t) => t.id === 'cat')
    expect(cat).toEqual(EXISTING.terms[0])
    expect(merged.terms.filter((t) => t.term.toLowerCase() === 'cat')).toHaveLength(1)
    expect(merged.terms.filter((t) => t.term.toLowerCase() === 'silver sword')).toHaveLength(1)
  })

  it('never re-adds an ignored term', () => {
    const merged = buildStatDict(REPORT, EXISTING, { minCount: 1 })
    expect(merged.terms.some((t) => t.term.toLowerCase() === 'mat')).toBe(false)
    expect(merged.ignored).toEqual(['mat'])
  })

  it('adds new terms with an empty translation and a guessed type', () => {
    const merged = buildStatDict(REPORT, { terms: [] }, { minCount: 3 })
    const sat = merged.terms.find((t) => t.term === 'sat')
    expect(sat).toEqual({
      id: 'sat',
      term: 'sat',
      type: 'character',
      count: 3,
      firstChapter: null,
      ru: null,
      aliases: [],
    })
    const ngram = merged.terms.find((t) => t.term === 'cat sat')
    expect(ngram?.type).toBe('term')
  })

  it('is deterministic', () => {
    const a = buildStatDict(REPORT, EXISTING, { minCount: 1 })
    const b = buildStatDict(REPORT, EXISTING, { minCount: 1 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('does not mutate the input glossary', () => {
    const before = JSON.stringify(EXISTING)
    buildStatDict(REPORT, EXISTING, { minCount: 1 })
    expect(JSON.stringify(EXISTING)).toBe(before)
  })

  it('round-trips through serializeGlossary / parseGlossary', () => {
    const merged = buildStatDict(REPORT, EXISTING, { minCount: 3 })
    const parsed = parseGlossary(serializeGlossary(merged))
    expect(parsed).toEqual(merged)
  })
})

describe('statDict tool', () => {
  it('stores the dictionary in meta and keeps the item untouched', async () => {
    const out = await statDict.invoke(
      { id: 'ex-test', variables: [], item: TEXT, meta: { chapterId: 'c1' } },
      CTX,
    )
    expect(out.item).toBe(TEXT)
    expect(out.meta.chapterId).toBe('c1')
    const glossary = getVariable(out, 'statDict') as Glossary
    expect(glossary.terms.map((t) => t.term)).toContain('cat')
    expect(getVariable(out, 'statDictJson')).toBe(serializeGlossary(glossary))
  })

  it('uses meta.statFreq when it is present', async () => {
    const report = buildStatFreqReport([
      'Dragon breathes fire. Dragon breathes fire. Dragon breathes fire.',
    ])
    const out = await statDict.invoke(exchangeOf(TEXT, { statFreq: report }), CTX)
    const glossary = getVariable(out, 'statDict') as Glossary
    expect(glossary.terms.map((t) => t.term)).toEqual([
      'breathes',
      'breathes fire',
      'dragon',
      'dragon breathes',
      'dragon breathes fire',
      'fire',
    ])
  })

  it('counts the envelope text when there is no report', async () => {
    const out = await statDict.invoke({ id: 'ex-test', variables: [], item: TEXT, meta: {} }, CTX)
    const glossary = getVariable(out, 'statDict') as Glossary
    expect(glossary.terms.find((t) => t.term === 'cat')?.count).toBe(3)
  })

  it('merges the glossary file and writes the result atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-stat-dict-'))
    try {
      const glossaryFile = join(dir, 'glossary.json')
      const outFile = join(dir, 'nested', 'dict.json')
      await writeFile(glossaryFile, serializeGlossary(EXISTING), 'utf-8')
      const tool = defineStatDict({ glossaryFile, outFile, minCount: 3 })
      const out = await tool.invoke({ id: 'ex-test', variables: [], item: TEXT, meta: {} }, CTX)
      const glossary = getVariable(out, 'statDict') as Glossary
      expect(glossary.terms[0]).toEqual(EXISTING.terms[0])
      expect(glossary.terms.filter((t) => t.term.toLowerCase() === 'cat')).toHaveLength(1)
      const written = await readFile(outFile, 'utf-8')
      expect(parseGlossary(written)).toEqual(glossary)
      const entries = await readdir(join(dir, 'nested'))
      expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('starts from an empty glossary when the glossary file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-stat-dict-'))
    try {
      const tool = defineStatDict({ glossaryFile: join(dir, 'nope.json') })
      const out = await tool.invoke({ id: 'ex-test', variables: [], item: TEXT, meta: {} }, CTX)
      const glossary = getVariable(out, 'statDict') as Glossary
      expect(glossary.terms.length).toBeGreaterThan(0)
      expect(glossary.terms.every((t) => t.ru === null)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails on a broken glossary file instead of dropping the translations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-stat-dict-'))
    try {
      const glossaryFile = join(dir, 'glossary.json')
      await writeFile(glossaryFile, '{ not json', 'utf-8')
      const tool = defineStatDict({ glossaryFile })
      await expect(
        tool.invoke({ id: 'ex-test', variables: [], item: TEXT, meta: {} }, CTX),
      ).rejects.toThrow(/cannot parse glossary file/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
