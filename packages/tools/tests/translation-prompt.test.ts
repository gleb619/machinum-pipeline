import { describe, expect, it } from 'vitest'

import type { Glossary } from '../src/normalization/term-tagger.js'
import {
  buildTranslationPrompt,
  cleanTranslation,
  joinReplyLines,
  termIdsIn,
} from '../src/normalization/translation-prompt.js'

const glossary: Glossary = {
  terms: [
    {
      id: 'arin',
      term: 'Arin',
      type: 'character',
      count: 3,
      firstChapter: 1,
      ru: 'Арин',
      aliases: [],
    },
    {
      id: 'keep',
      term: 'Iron Keep',
      type: 'place',
      count: 2,
      firstChapter: 1,
      ru: 'Железная крепость',
      aliases: [],
    },
    {
      id: 'zorg',
      term: 'Zorg',
      type: 'character',
      count: 2,
      firstChapter: 1,
      ru: null,
      aliases: [],
    },
    {
      id: 'river',
      term: 'Silver River',
      type: 'place',
      count: 2,
      firstChapter: 2,
      ru: 'Серебряная река',
      aliases: [],
    },
  ],
}

const TAGGED =
  '<term id="arin">Arin</term> met <term id="zorg">Zorg</term> at the <term id="keep">Iron Keep</term>.'

describe('buildTranslationPrompt', () => {
  const p = buildTranslationPrompt({ text: TAGGED, glossary, summary: 'A short summary.' })

  it('finds term ids in order', () => {
    expect(termIdsIn(TAGGED)).toEqual(['arin', 'zorg', 'keep'])
  })

  it('injects only terms present in the unit', () => {
    expect(p.usedTerms.map((t) => t.id)).toEqual(['arin', 'zorg', 'keep'])
    expect(p.systemPrompt).toContain('Arin = Арин')
    expect(p.systemPrompt).toContain('Iron Keep = Железная крепость')
    expect(p.systemPrompt).not.toContain('Silver River')
    expect(p.systemPrompt).not.toContain('Серебряная')
  })

  it('asks to transliterate terms without ru', () => {
    expect(p.untranslatedTerms.map((t) => t.id)).toEqual(['zorg'])
    expect(p.systemPrompt).toMatch(/transliterate[\s\S]*Zorg/)
    expect(p.systemPrompt).not.toContain('Zorg =')
  })

  it('adds the summary as context and strips tags from the user prompt', () => {
    expect(p.systemPrompt).toContain('A short summary.')
    // tags stripped; plain-mode input is the bare text (no wrapper)
    expect(p.userPrompt).toBe('Arin met Zorg at the Iron Keep.')
  })

  it('has no glossary block when no term is present', () => {
    const q = buildTranslationPrompt({ text: 'Plain line.', glossary })
    expect(q.usedTerms).toEqual([])
    expect(q.systemPrompt).not.toContain('Glossary')
    expect(q.systemPrompt).not.toContain('summary')
  })
})

describe('buildTranslationPrompt with locked terms', () => {
  const lockedGlossary: Glossary = {
    terms: [
      ...glossary.terms,
      {
        id: 'mira',
        term: 'Mira',
        type: 'character',
        count: 1,
        firstChapter: 3,
        ru: 'Мира',
        aliases: [],
        locked: true,
      },
      {
        id: 'vale',
        term: 'Vale',
        type: 'place',
        count: 1,
        firstChapter: 3,
        ru: null,
        aliases: [],
        locked: true,
      },
    ],
  }

  it('injects locked terms even when their id does not occur in the text', () => {
    const p = buildTranslationPrompt({ text: TAGGED, glossary: lockedGlossary })
    expect(p.systemPrompt).toContain('Mira = Мира')
    expect(p.systemPrompt).toMatch(/transliterate[\s\S]*Vale/)
    expect(p.lockedTerms.map((t) => t.id)).toEqual(['mira', 'vale'])
    expect(p.usedTerms.map((t) => t.id)).toEqual(['arin', 'zorg', 'keep'])
  })

  it('does not duplicate a locked term that also occurs in the text', () => {
    const tagged = `${TAGGED} She is <term id="mira">Mira</term> of the <term id="vale">Vale</term>.`
    const p = buildTranslationPrompt({ text: tagged, glossary: lockedGlossary })
    expect(p.lockedTerms).toEqual([])
    expect(p.systemPrompt.match(/Mira = Мира/g)).toHaveLength(1)
  })

  it('injects nothing extra when no term is locked', () => {
    const p = buildTranslationPrompt({ text: TAGGED, glossary })
    expect(p.lockedTerms).toEqual([])
  })
})

describe('cleanTranslation', () => {
  it('removes think blocks and term tags', () => {
    expect(cleanTranslation('<think>hm\nhm</think>\n<term id="a">Арин</term> пришёл. ')).toBe(
      'Арин пришёл.',
    )
  })
})

describe('joinReplyLines', () => {
  it('joins split replies into one line', () => {
    expect(joinReplyLines('Первая часть.\n\n Вторая часть.\n')).toBe('Первая часть. Вторая часть.')
    expect(joinReplyLines('Одна строка.')).toBe('Одна строка.')
  })
})
