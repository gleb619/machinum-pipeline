import { describe, expect, it } from 'vitest'

import {
  mergeReportedTerms,
  parseGlossary,
  serializeGlossary,
} from '../src/normalization/glossary-extractor.js'
import type { Glossary } from '../src/normalization/term-tagger.js'
import {
  buildTranslationPrompt,
  cleanTranslation,
  parseReportedTerms,
} from '../src/normalization/translation-prompt.js'

const glossary: Glossary = {
  terms: [
    {
      id: 'arin-vale',
      term: 'Arin Vale',
      type: 'character',
      count: 3,
      firstChapter: 1,
      ru: 'Арин Вейл',
      aliases: ['Arin'],
    },
    {
      id: 'iron-keep',
      term: 'Iron Keep',
      type: 'place',
      count: 2,
      firstChapter: 1,
      ru: null,
      aliases: [],
    },
  ],
  ignored: ['Marta'],
}

describe('parseReportedTerms', () => {
  it('parses a valid <terms> JSON block', () => {
    const reply = [
      'Перевод строки.',
      '<terms>[{"term":"Silver River","ru":"Серебряная река","type":"place"},{"term":"Grog","ru":null}]</terms>',
    ].join('\n')
    expect(parseReportedTerms(reply)).toEqual([
      { term: 'Silver River', ru: 'Серебряная река', type: 'place' },
      { term: 'Grog', ru: null, type: null },
    ])
  })

  it('returns [] when there is no <terms> block', () => {
    expect(parseReportedTerms('just translation')).toEqual([])
  })

  it('returns [] for malformed JSON instead of throwing', () => {
    expect(parseReportedTerms('<terms>[{"term": oops]</terms>')).toEqual([])
    expect(parseReportedTerms('<terms>not json</terms>')).toEqual([])
  })

  it('keeps only schema-valid entries and normalizes ru', () => {
    const reply =
      '<terms>[{"term":"Ok","ru":"Ок"},{"term":"","ru":"Хм"},' +
      '{"term":"NoRu"},{"term":"Bad","ru":"Х","type":"monster"},42]</terms>'
    expect(parseReportedTerms(reply)).toEqual([
      { term: 'Ok', ru: 'Ок', type: null },
      { term: 'NoRu', ru: null, type: null },
    ])
  })

  it('dedupes repeated terms case-insensitively, first ru wins', () => {
    const reply = '<terms>[{"term":"Grog","ru":"Грог"},{"term":"grog","ru":"Другой"}]</terms>'
    expect(parseReportedTerms(reply)).toEqual([{ term: 'Grog', ru: 'Грог', type: null }])
  })
})

describe('buildTranslationPrompt <terms> instruction', () => {
  it('asks the model to report new terms in a trailing <terms> block', () => {
    const { systemPrompt } = buildTranslationPrompt({
      text: 'Arin Vale walked.',
      glossary,
    })
    expect(systemPrompt).toContain('<terms>')
    expect(systemPrompt).toContain('NOT in the glossary')
  })
})

describe('cleanTranslation with <terms> block', () => {
  it('strips the <terms> block and keeps the translation lines', () => {
    const reply = ['Первая строка.', '<terms>[{"term":"Grog","ru":"Грог"}]</terms>'].join('\n')
    expect(cleanTranslation(reply)).toBe('Первая строка.')
  })

  it('strips a multi-line <terms> block', () => {
    const reply = ['Первая строка.', '<terms>', '[{"term":"Grog"}]', '</terms>'].join('\n')
    expect(cleanTranslation(reply)).toBe('Первая строка.')
  })
})

describe('mergeReportedTerms', () => {
  it('auto-adds a brand-new term with its reported ru', () => {
    const out = mergeReportedTerms(glossary, [
      { term: 'Silver River', ru: 'Серебряная река', type: 'place' },
    ])
    const t = out.terms.find((x) => x.term === 'Silver River')
    expect(t).toMatchObject({
      type: 'place',
      ru: 'Серебряная река',
      count: 0,
      firstChapter: null,
      aliases: [],
    })
    expect(t?.id).toBe('silver-river')
  })

  it('guesses the type when the report has none', () => {
    const out = mergeReportedTerms(glossary, [{ term: 'Black Forest', ru: null, type: null }])
    expect(out.terms.find((x) => x.term === 'Black Forest')?.type).toBe('place')
  })

  it('never auto-renames: a new ru for an existing term goes to pending', () => {
    const out = mergeReportedTerms(glossary, [{ term: 'Arin Vale', ru: 'Арин Вэйл', type: null }])
    const t = out.terms.find((x) => x.id === 'arin-vale')
    expect(t?.ru).toBe('Арин Вейл')
    expect(t?.pending).toEqual(['Арин Вэйл'])
  })

  it('routes reports matching an alias to the same entry', () => {
    const out = mergeReportedTerms(glossary, [{ term: 'Arin', ru: 'Арин', type: null }])
    expect(out.terms.find((x) => x.id === 'arin-vale')?.pending).toEqual(['Арин'])
  })

  it('does not queue a value equal to the current ru or already pending', () => {
    const once = mergeReportedTerms(glossary, [{ term: 'Arin Vale', ru: 'Арин Вэйл', type: null }])
    const twice = mergeReportedTerms(once, [
      { term: 'Arin Vale', ru: 'Арин Вэйл', type: null },
      { term: 'Arin Vale', ru: 'Арин Вейл', type: null },
    ])
    expect(twice.terms.find((x) => x.id === 'arin-vale')?.pending).toEqual(['Арин Вэйл'])
  })

  it('never applies or re-queues rejected values', () => {
    const withRejected: Glossary = {
      ...glossary,
      rejected: ['Арин Вэйл'],
    }
    const out = mergeReportedTerms(withRejected, [
      { term: 'Arin Vale', ru: 'Арин Вэйл', type: null },
      { term: 'Grog', ru: 'Арин Вэйл', type: null },
    ])
    expect(out.terms.find((x) => x.id === 'arin-vale')?.pending).toBeUndefined()
    expect(out.terms.find((x) => x.term === 'Grog')?.ru).toBeNull()
  })

  it('never queues a proposal for a locked term (ru is final)', () => {
    const locked: Glossary = {
      ...glossary,
      terms: glossary.terms.map((t) => (t.id === 'arin-vale' ? { ...t, locked: true } : t)),
    }
    const out = mergeReportedTerms(locked, [{ term: 'Arin Vale', ru: 'Арин Вэйл', type: null }])
    const t = out.terms.find((x) => x.id === 'arin-vale')
    expect(t?.ru).toBe('Арин Вейл')
    expect(t?.pending).toBeUndefined()
    expect(t?.locked).toBe(true)
  })

  it('never adds terms listed in ignored', () => {
    const out = mergeReportedTerms(glossary, [{ term: 'Marta', ru: 'Марта', type: null }])
    expect(out.terms.some((x) => x.term === 'Marta')).toBe(false)
  })

  it('keeps ignored/rejected and does not mutate the input glossary', () => {
    const input: Glossary = { ...glossary, rejected: ['Хм'] }
    const before = JSON.parse(JSON.stringify(input)) as unknown
    const out = mergeReportedTerms(input, [{ term: 'Grog', ru: 'Грог', type: null }])
    expect(out.ignored).toEqual(['Marta'])
    expect(out.rejected).toEqual(['Хм'])
    expect(input).toEqual(before)
  })

  it('creates unique ids for slug collisions', () => {
    const existing: Glossary = {
      terms: [
        {
          id: 'grog',
          term: 'Grog (Bouncer)',
          type: 'character',
          count: 1,
          firstChapter: 1,
          ru: null,
          aliases: [],
        },
      ],
    }
    const out = mergeReportedTerms(existing, [{ term: 'Grog', ru: 'Грог', type: null }])
    expect(out.terms.map((x) => x.id).sort()).toEqual(['grog', 'grog-2'])
  })
})

describe('glossary.json round trip with pending/rejected', () => {
  it('parseGlossary/serializeGlossary preserve pending and rejected', () => {
    const merged = mergeReportedTerms(glossary, [
      { term: 'Arin Vale', ru: 'Арин Вэйл', type: null },
    ])
    const restored = parseGlossary(serializeGlossary(merged))
    expect(restored).toEqual(merged)
  })

  it('parses glossaries without the new fields', () => {
    const restored = parseGlossary(
      '{"terms":[{"id":"a","term":"A","type":"term","count":1,"firstChapter":1,"ru":null,"aliases":[]}]}',
    )
    expect(restored?.terms[0]?.pending).toBeUndefined()
    expect(restored?.rejected).toBeUndefined()
  })
})
