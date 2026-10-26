import { describe, expect, it } from 'vitest'

import type { Glossary, GlossaryTerm } from '../src/normalization/term-tagger.js'
import {
  genderFlipsAt,
  resolveGlossaryAtChapter,
  resolveTermAtChapter,
  validateTimeline,
  verifyEvidenceQuotes,
} from '../src/normalization/term-timeline.js'

function term(overrides: Partial<GlossaryTerm> = {}): GlossaryTerm {
  return {
    id: 'arin',
    term: 'Arin',
    type: 'character',
    count: 5,
    firstChapter: 1,
    ru: 'Арин',
    aliases: [],
    ...overrides,
  }
}

const F_ENDINGS = {
  nominative: { singular: 'а', plural: 'ы' },
  genitive: { singular: 'ы', plural: '' },
  dative: { singular: 'е', plural: 'ам' },
  accusative: { singular: 'у', plural: 'ы' },
  instrumental: { singular: 'ой', plural: 'ами' },
  prepositional: { singular: 'е', plural: 'ах' },
}

describe('resolveTermAtChapter', () => {
  it('returns base ru/gender when no timeline applies', () => {
    const t = term({ ruGrammar: { gender: 'm', declension: 2, endings: F_ENDINGS } })
    expect(resolveTermAtChapter(t, 7)).toEqual({
      ru: 'Арин',
      gender: 'm',
      genderFlip: null,
      notYetIntroduced: false,
    })
  })

  it('applies the latest ruTimeline entry at or below the chapter', () => {
    const t = term({
      ruTimeline: [
        { chapter: 5, value: 'Арина' },
        { chapter: 10, value: 'Арин-Сан' },
      ],
    })
    expect(resolveTermAtChapter(t, 4).ru).toBe('Арин')
    expect(resolveTermAtChapter(t, 5).ru).toBe('Арина')
    expect(resolveTermAtChapter(t, 9).ru).toBe('Арина')
    expect(resolveTermAtChapter(t, 10).ru).toBe('Арин-Сан')
  })

  it('applies gender flips from their chapter onward and reports them', () => {
    const t = term({
      ruGrammar: { gender: 'm', declension: 2, endings: F_ENDINGS },
      genderTimeline: [
        {
          chapter: 8,
          value: 'f',
          evidence: { chapter: 8, quote: 'she took off her helmet' },
        },
      ],
    })
    expect(resolveTermAtChapter(t, 7).gender).toBe('m')
    const at8 = resolveTermAtChapter(t, 8)
    expect(at8.gender).toBe('f')
    expect(at8.genderFlip).toEqual({
      chapter: 8,
      value: 'f',
      evidence: { chapter: 8, quote: 'she took off her helmet' },
    })
    expect(resolveTermAtChapter(t, 12).genderFlip?.value).toBe('f')
  })

  it('no flip when the timeline restates the base gender', () => {
    const t = term({
      ruGrammar: { gender: 'f', declension: 1, endings: F_ENDINGS },
      genderTimeline: [{ chapter: 3, value: 'f', evidence: { chapter: 3, quote: 'q' } }],
    })
    expect(resolveTermAtChapter(t, 5).genderFlip).toBeNull()
  })

  it('flip from unknown base gender counts as a flip', () => {
    const t = term({
      genderTimeline: [{ chapter: 3, value: 'n', evidence: { chapter: 3, quote: 'q' } }],
    })
    expect(resolveTermAtChapter(t, 3).genderFlip?.value).toBe('n')
  })

  it('flags terms not yet introduced at the chapter', () => {
    expect(resolveTermAtChapter(term({ firstChapter: 4 }), 3).notYetIntroduced).toBe(true)
    expect(resolveTermAtChapter(term({ firstChapter: 4 }), 4).notYetIntroduced).toBe(false)
    expect(resolveTermAtChapter(term({ firstChapter: null }), 1).notYetIntroduced).toBe(false)
  })
})

describe('resolveGlossaryAtChapter', () => {
  const glossary: Glossary = {
    terms: [
      term({ id: 'arin', term: 'Arin', ruTimeline: [{ chapter: 5, value: 'Арина' }] }),
      term({ id: 'keep', term: 'Iron Keep', firstChapter: 9, ru: 'Железная крепость' }),
      term({ id: 'plain', term: 'Sword', firstChapter: 1, ru: 'Меч' }),
    ],
  }

  it('drops terms whose firstChapter lies after the chapter', () => {
    const at4 = resolveGlossaryAtChapter(glossary, 4)
    expect(at4.terms.map((t) => t.id)).toEqual(['arin', 'plain'])
    const at9 = resolveGlossaryAtChapter(glossary, 9)
    expect(at9.terms.map((t) => t.id)).toEqual(['arin', 'keep', 'plain'])
  })

  it('applies timeline overrides and leaves other terms untouched', () => {
    const at7 = resolveGlossaryAtChapter(glossary, 7)
    expect(at7.terms.find((t) => t.id === 'arin')?.ru).toBe('Арина')
    expect(at7.terms.find((t) => t.id === 'plain')).toBe(glossary.terms[2])
    expect(resolveGlossaryAtChapter(glossary, 4).terms.find((t) => t.id === 'arin')?.ru).toBe(
      'Арин',
    )
  })

  it('overrides ruGrammar gender with the effective flip', () => {
    const g: Glossary = {
      terms: [
        term({
          ruGrammar: { gender: 'm', declension: 2, endings: F_ENDINGS },
          genderTimeline: [{ chapter: 2, value: 'f', evidence: { chapter: 2, quote: 'q' } }],
        }),
      ],
    }
    const resolved = resolveGlossaryAtChapter(g, 3).terms[0]
    expect(resolved?.ruGrammar?.gender).toBe('f')
    expect(g.terms[0]?.ruGrammar?.gender).toBe('m') // original untouched
  })
})

describe('genderFlipsAt', () => {
  it('collects active flips keyed by term id', () => {
    const g: Glossary = {
      terms: [
        term({
          ruGrammar: { gender: 'm', declension: 2, endings: F_ENDINGS },
          genderTimeline: [{ chapter: 6, value: 'f', evidence: { chapter: 6, quote: 'q' } }],
        }),
        term({ id: 'other', term: 'Other' }),
      ],
    }
    expect(genderFlipsAt(g, 5).size).toBe(0)
    expect(genderFlipsAt(g, 6).get('arin')?.value).toBe('f')
  })
})

describe('validateTimeline', () => {
  it('accepts a clean glossary', () => {
    const g: Glossary = {
      terms: [
        term({
          ruTimeline: [{ chapter: 2, value: 'x' }],
          genderTimeline: [{ chapter: 3, value: 'f', evidence: { chapter: 3, quote: 'q' } }],
        }),
      ],
    }
    expect(validateTimeline(g)).toEqual([])
  })

  it('reports unsorted timelines', () => {
    const g: Glossary = {
      terms: [
        term({
          ruTimeline: [
            { chapter: 5, value: 'b' },
            { chapter: 2, value: 'a' },
          ],
        }),
      ],
    }
    const issues = validateTimeline(g)
    expect(issues.map((i) => i.code)).toEqual(['unsorted-timeline'])
  })

  it('reports gender flips without evidence or with an empty quote', () => {
    const g = {
      terms: [
        term({
          genderTimeline: [
            { chapter: 3, value: 'f' },
            { chapter: 4, value: 'n', evidence: { chapter: 4, quote: '  ' } },
          ] as unknown as GlossaryTerm['genderTimeline'],
        }),
      ],
    } as unknown as Glossary
    expect(validateTimeline(g).map((i) => i.code)).toEqual([
      'flip-without-evidence',
      'empty-evidence-quote',
    ])
  })
})

describe('verifyEvidenceQuotes', () => {
  const g: Glossary = {
    terms: [
      term({
        genderTimeline: [
          { chapter: 2, value: 'f', evidence: { chapter: 2, quote: 'she smiled' } },
          { chapter: 5, value: 'n', evidence: { chapter: 5, quote: 'it shimmered' } },
        ],
      }),
    ],
  }
  const corpus = new Map<number, string>([
    [2, '... she smiled at him ...'],
    [5, 'nothing relevant here'],
  ])

  it('passes quotes found verbatim in their chapter source', () => {
    const issues = verifyEvidenceQuotes(g, (n) => corpus.get(n))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('quote-not-in-source')
    expect(issues[0]?.detail).toContain('chapter 5')
  })

  it('flags quotes when the chapter source is unknown', () => {
    expect(verifyEvidenceQuotes(g, () => undefined)).toHaveLength(2)
  })
})
