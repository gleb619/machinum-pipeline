import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { exchangeOf } from './exchange-helper.js'

import {
  buildGlossary,
  createGlossaryExtractor,
  guessType,
} from '../src/normalization/glossary-extractor.js'
import { summarizeHeuristic } from '../src/normalization/heuristic-summary.js'
import { stripTerms, tagTerms, termTagger } from '../src/normalization/term-tagger.js'
import type { Glossary } from '../src/normalization/term-tagger.js'

const CH1 = [
  '# Chapter 1: Start',
  '',
  'Arin Vale walked into the Iron Keep with Marta. Arin Vale smiled.',
  '',
  '"Take the [Flame Strike]," Marta said. Marta laughed at Arin Vale.',
  '',
  '[System: level up!]',
  '',
  '```',
  'Arin Vale in code',
  '```',
].join('\n')

const CH2 = [
  '# Chapter 2: Next',
  '',
  'The Iron Keep fell silent. Then Marta nodded. She cast [Flame Strike] and [Flame Strike] again.',
  '',
  'They crossed the Silver River. Later the Silver River froze.',
].join('\n')

const chapters = [
  { chapter: 1, text: CH1 },
  { chapter: 2, text: CH2 },
]

const byTerm = (g: Glossary, term: string) => g.terms.find((t) => t.term === term)

describe('buildGlossary', () => {
  const g = buildGlossary(chapters)

  it('finds multiword names, bracketed terms and repeated singles with type guesses', () => {
    expect(byTerm(g, 'Arin Vale')).toMatchObject({ type: 'character', count: 3, firstChapter: 1 })
    expect(byTerm(g, 'Iron Keep')?.count).toBe(2)
    expect(byTerm(g, 'Silver River')).toMatchObject({ type: 'place', count: 2, firstChapter: 2 })
    expect(byTerm(g, '[Flame Strike]')).toMatchObject({ type: 'skill', count: 3, firstChapter: 1 })
    expect(byTerm(g, 'Marta')).toMatchObject({ type: 'character', ru: null, aliases: [] })
  })

  it('skips system messages, headings and code', () => {
    expect(g.terms.some((t) => t.term.includes('System'))).toBe(false)
    expect(g.terms.some((t) => t.term === 'Chapter')).toBe(false)
    expect(byTerm(g, 'Arin Vale')?.count).toBe(3)
  })

  it('has unique slug ids', () => {
    const ids = g.terms.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(byTerm(g, 'Arin Vale')?.id).toBe('arin-vale')
  })

  it('preserves ru, aliases, type and manual terms on re-run', () => {
    const edited: Glossary = {
      terms: g.terms.map((t) =>
        t.term === 'Marta' ? { ...t, ru: 'Марта', aliases: ['Marty'], type: 'term' as const } : t,
      ),
    }
    edited.terms.push({
      id: 'manual',
      term: 'Silver',
      type: 'item',
      count: 0,
      firstChapter: null,
      ru: 'Серебро',
      aliases: [],
    })
    const again = buildGlossary(chapters, edited)
    expect(byTerm(again, 'Marta')).toMatchObject({ ru: 'Марта', aliases: ['Marty'], type: 'term' })
    expect(byTerm(again, 'Silver')).toMatchObject({ ru: 'Серебро', id: 'manual' })
    expect(again.terms.slice(0, edited.terms.length).map((t) => t.id)).toEqual(
      edited.terms.map((t) => t.id),
    )
    expect(buildGlossary(chapters, again)).toEqual(again)
  })

  it('never re-adds ignored terms', () => {
    const ign = buildGlossary(chapters, { terms: [], ignored: ['Marta'] })
    expect(byTerm(ign, 'Marta')).toBeUndefined()
  })

  it('guessType covers place/item/skill/term', () => {
    expect(guessType('Dark Forest')).toBe('place')
    expect(guessType('Mount Doom')).toBe('place')
    expect(guessType('Moon Sword')).toBe('item')
    expect(guessType('[Wind Slash]')).toBe('skill')
    expect(guessType('Mage Guild')).toBe('term')
  })
})

describe('tool wrappers', () => {
  const ctx = {} as ToolContext
  it('glossaryExtractor tool reads existing glossary through load()', async () => {
    const tool = createGlossaryExtractor({
      load: async () => ({
        terms: [
          {
            id: 'marta',
            term: 'Marta',
            type: 'character',
            count: 0,
            firstChapter: null,
            ru: 'М',
            aliases: [],
          },
        ],
      }),
    })
    const res = await tool.invoke(
      { id: 'ex-test', variables: [], item: [CH1, CH2], items: [CH1, CH2], meta: {} },
      ctx,
    )
    const glossary = getVariable(res, 'glossary') as Glossary
    expect(byTerm(glossary, 'Marta')?.ru).toBe('М')
    expect(getVariable(res, 'chapterNums')).toEqual([1, 2])
  })

  it('termTagger stores tagged copies in meta, item untouched', async () => {
    const g = buildGlossary(chapters)
    const res = await termTagger.invoke(exchangeOf(CH1, { glossary: g }), ctx)
    expect(res.item).toBe(CH1)
    expect(getVariable(res, 'tagged')).toContain('<term id="arin-vale">Arin Vale</term>')
  })
})

describe('tagTerms / stripTerms', () => {
  const g = buildGlossary(chapters)

  it('wraps longest match first without nesting', () => {
    const glossary: Glossary = {
      terms: [
        {
          id: 'a',
          term: 'Arin',
          type: 'character',
          count: 0,
          firstChapter: null,
          ru: null,
          aliases: [],
        },
        {
          id: 'av',
          term: 'Arin Vale',
          type: 'character',
          count: 0,
          firstChapter: null,
          ru: null,
          aliases: ['Vale'],
        },
      ],
    }
    expect(tagTerms('Arin Vale met Arin and Vale.', glossary)).toBe(
      '<term id="av">Arin Vale</term> met <term id="a">Arin</term> and <term id="av">Vale</term>.',
    )
  })

  it('respects word boundaries and skips code', () => {
    const out = tagTerms(CH1, g)
    expect(out).toContain('<term id="flame-strike">[Flame Strike]</term>')
    expect(out).toContain('\nArin Vale in code\n')
    expect(tagTerms('Martan and Marta', g)).toBe('Martan and <term id="marta">Marta</term>')
    expect(tagTerms('use `Marta` here', g)).toBe('use `Marta` here')
  })

  it('is idempotent', () => {
    const once = tagTerms(CH1 + CH2, g)
    expect(tagTerms(once, g)).toBe(once)
  })

  it('strip(tag(x)) === x and line count is preserved', () => {
    for (const x of [CH1, CH2, `${CH1}\n\n${CH2}\n`, '']) {
      const tagged = tagTerms(x, g)
      expect(stripTerms(tagged)).toBe(x)
      expect(tagged.split('\n').length).toBe(x.split('\n').length)
    }
  })
})

describe('summarizeHeuristic', () => {
  it('returns lead sentence plus top sentences in original order', () => {
    const md = [
      '# Title',
      '',
      'The dragon guarded the golden treasure deep inside the mountain.',
      'Rain fell on the village that night.',
      'The dragon hoarded golden treasure and the dragon never slept near the treasure.',
      'A farmer sold some turnips at the market today.',
      'Everyone feared the dragon and its golden treasure hoard.',
      'The cat sat quietly on the old stone wall.',
    ].join('\n')
    const s = summarizeHeuristic(md, { sentences: 3 })
    expect(s.startsWith('The dragon guarded')).toBe(true)
    expect(s).toContain('hoarded golden treasure')
    expect(s).not.toContain('turnips')
    expect(s).not.toContain('# Title')
  })

  it('returns everything for short chapters', () => {
    expect(summarizeHeuristic('# T\n\nOne short sentence here.\nAnd another one here.')).toBe(
      'One short sentence here. And another one here.',
    )
  })
})

describe('extraction edge cases', () => {
  it('drops possessives and leading gerunds from names', () => {
    const text = "Seeing Arin Vale's sword. Arin Vale's pride grew. Hearing Arin Vale again."
    const g = buildGlossary([{ chapter: 1, text }])
    expect(g.terms.map((t) => t.term)).toContain('Arin Vale')
    expect(g.terms.some((t) => t.term.includes("'s") || t.term.startsWith('Seeing'))).toBe(false)
  })
})
