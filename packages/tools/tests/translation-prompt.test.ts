import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDefaultPrompt, renderTemplate } from '../src/core/llm-prompts.js'
import type { Glossary } from '../src/normalization/term-tagger.js'
import {
  buildTranslationPrompt,
  cleanTranslation,
  joinReplyLines,
  termIdsIn,
  translateTermsEnabled,
  translateTermsInstruction,
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

describe('buildTranslationPrompt with chapter resolution', () => {
  const timelineGlossary: Glossary = {
    terms: [
      {
        id: 'arin',
        term: 'Arin',
        type: 'character',
        count: 5,
        firstChapter: 1,
        ru: 'Арин',
        aliases: [],
        ruGrammar: { gender: 'm', declension: 2, endings: {} as never },
        ruTimeline: [{ chapter: 5, value: 'Арина' }],
        genderTimeline: [
          { chapter: 8, value: 'f', evidence: { chapter: 8, quote: 'she took off her helmet' } },
        ],
      },
      {
        id: 'mira',
        term: 'Mira',
        type: 'character',
        count: 2,
        firstChapter: 10,
        ru: 'Мира',
        aliases: [],
      },
    ],
  }
  const tagged =
    '<term id="arin">Arin</term> smiled, then <term id="mira">Mira</term> entered the room.'

  it('resolves ruTimeline at the chapter: old ru before, new ru from the entry', () => {
    const before = buildTranslationPrompt({ text: tagged, glossary: timelineGlossary, chapter: 4 })
    expect(before.systemPrompt).toContain('Arin = Арин')
    expect(before.systemPrompt).not.toContain('Арина')
    const after = buildTranslationPrompt({ text: tagged, glossary: timelineGlossary, chapter: 6 })
    expect(after.systemPrompt).toContain('Arin = Арина')
    expect(after.systemPrompt).not.toContain('Arin = Арин\n')
  })

  it('excludes terms not yet introduced at the chapter', () => {
    const p = buildTranslationPrompt({ text: tagged, glossary: timelineGlossary, chapter: 6 })
    expect(p.usedTerms.map((t) => t.id)).toEqual(['arin'])
    expect(p.systemPrompt).not.toContain('Mira = Мира')
    const later = buildTranslationPrompt({ text: tagged, glossary: timelineGlossary, chapter: 10 })
    expect(later.usedTerms.map((t) => t.id)).toEqual(['arin', 'mira'])
    expect(later.systemPrompt).toContain('Mira = Мира')
  })

  it('announces active gender flips with verbatim evidence, silent before the flip', () => {
    const before = buildTranslationPrompt({ text: tagged, glossary: timelineGlossary, chapter: 7 })
    expect(before.systemPrompt).not.toContain('Gender notes')
    const at = buildTranslationPrompt({ text: tagged, glossary: timelineGlossary, chapter: 8 })
    expect(at.systemPrompt).toContain('Gender notes for this chapter:')
    expect(at.systemPrompt).toContain(
      '- Arin is feminine from chapter 8, revealed in chapter 8: "she took off her helmet"; inflect pronouns and adjectives accordingly.',
    )
  })

  it('behaves like before when no chapter is given', () => {
    const p = buildTranslationPrompt({ text: tagged, glossary: timelineGlossary })
    expect(p.systemPrompt).toContain('Arin = Арин')
    expect(p.systemPrompt).toContain('Mira = Мира')
    expect(p.systemPrompt).not.toContain('Gender notes')
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

describe('MT_TRANSLATE_TERMS switch', () => {
  const paragraph = translateTermsInstruction('English')

  it('keeps the default render byte-identical to the pre-switch prompt', () => {
    const template = getDefaultPrompt('translate.system')?.template ?? ''
    const rendered = renderTemplate(
      template,
      {
        sourceLang: 'English',
        targetLang: 'Russian',
        text: '',
        glossaryBlock: '',
        entityBlock: '',
        vocabBlock: '',
        priorTermsBlock: '',
        summaryBlock: '',
        extraRules: '',
        termsBlock: paragraph,
        mode: 'plain',
      },
      'translate.system',
    ).trim()
    // Snapshot of the bundled prompt with the literal paragraph, before {{termsBlock}} split it
    // out. The 1752-char / 55e12372 snapshot from the brief predates {{entityBlock}} /
    // {{vocabBlock}} and {{priorTermsBlock}}: those empty slots add newlines (recorded 2026-11-15).
    expect(rendered).toHaveLength(1758)
    expect(createHash('sha256').update(rendered).digest('hex')).toBe(
      '743d266698de22e8a485e34f2f211c645334ffef25461fa8318b842e3cadd2db',
    )
  })

  it('defaults to on', () => {
    const implicit = buildTranslationPrompt({ text: '', glossary: { terms: [] } }).systemPrompt
    const explicit = buildTranslationPrompt({
      text: '',
      glossary: { terms: [] },
      terms: true,
    }).systemPrompt
    expect(implicit).toBe(explicit)
    expect(implicit).toContain('<terms>[...]</terms>')
  })

  it('off removes exactly the paragraph and its blank-line separator', () => {
    const input = { text: '', glossary: { terms: [] }, summary: 'A short summary.' }
    const on = buildTranslationPrompt(input).systemPrompt
    const off = buildTranslationPrompt({ ...input, terms: false }).systemPrompt
    expect(on).toContain(`\n\n${paragraph}\n\n`)
    expect(off).not.toContain('<terms>')
    expect(off).toBe(on.replace(`\n\n${paragraph}\n\n`, '\n\n'))
  })

  it('off in the empty-blocks case leaves no trailing newline run', () => {
    const on = buildTranslationPrompt({ text: '', glossary: { terms: [] } }).systemPrompt
    const off = buildTranslationPrompt({
      text: '',
      glossary: { terms: [] },
      terms: false,
    }).systemPrompt
    expect(on).toContain(paragraph)
    expect(off).not.toContain('<terms>')
    expect(off).not.toMatch(/\n{3,}$/)
  })

  it('unknown, empty and unset values mean on', () => {
    expect(translateTermsEnabled({ MT_TRANSLATE_TERMS: 'maybe' })).toBe(true)
    expect(translateTermsEnabled({ MT_TRANSLATE_TERMS: '' })).toBe(true)
    expect(translateTermsEnabled({})).toBe(true)
    expect(translateTermsEnabled({ MT_TRANSLATE_TERMS: 'ON' })).toBe(true)
  })

  it('is off only for off, case-insensitively', () => {
    expect(translateTermsEnabled({ MT_TRANSLATE_TERMS: 'off' })).toBe(false)
    expect(translateTermsEnabled({ MT_TRANSLATE_TERMS: ' OFF ' })).toBe(false)
  })

  it('the switch value feeds the builder', () => {
    const maybe = translateTermsEnabled({ MT_TRANSLATE_TERMS: 'maybe' })
    const off = translateTermsEnabled({ MT_TRANSLATE_TERMS: 'off' })
    const make = (terms: boolean) =>
      buildTranslationPrompt({ text: '', glossary: { terms: [] }, terms }).systemPrompt
    expect(make(maybe)).toContain(paragraph)
    expect(make(off)).not.toContain(paragraph)
  })
})

describe('MT_TRANSLATE_TERMS is the default when terms is absent', () => {
  const paragraph = translateTermsInstruction('English')
  const input = { text: '', glossary: { terms: [] } }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('renders no <terms> instruction when the env is off and terms is absent', () => {
    vi.stubEnv('MT_TRANSLATE_TERMS', 'off')
    const prompt = buildTranslationPrompt(input).systemPrompt
    expect(prompt).not.toContain('<terms>')
    expect(prompt).not.toContain(paragraph)
  })

  it('is byte-identical to the pre-switch ON render when the env is unset', () => {
    vi.stubEnv('MT_TRANSLATE_TERMS', undefined)
    const implicit = buildTranslationPrompt(input).systemPrompt
    const explicitOn = buildTranslationPrompt({ ...input, terms: true }).systemPrompt
    expect(implicit).toBe(explicitOn)

    const template = getDefaultPrompt('translate.system')?.template ?? ''
    const rendered = renderTemplate(
      template,
      {
        sourceLang: 'English',
        targetLang: 'Russian',
        text: '',
        glossaryBlock: '',
        entityBlock: '',
        vocabBlock: '',
        priorTermsBlock: '',
        summaryBlock: '',
        extraRules: '',
        termsBlock: paragraph,
        mode: 'plain',
      },
      'translate.system',
    ).trim()
    expect(rendered).toHaveLength(1758)
    expect(createHash('sha256').update(rendered).digest('hex')).toBe(
      '743d266698de22e8a485e34f2f211c645334ffef25461fa8318b842e3cadd2db',
    )
  })

  it('an explicit terms: true overrides an off environment', () => {
    vi.stubEnv('MT_TRANSLATE_TERMS', 'off')
    const prompt = buildTranslationPrompt({ ...input, terms: true }).systemPrompt
    expect(prompt).toContain(paragraph)
  })

  it('an explicit terms: false overrides an unset environment', () => {
    vi.stubEnv('MT_TRANSLATE_TERMS', undefined)
    const prompt = buildTranslationPrompt({ ...input, terms: false }).systemPrompt
    expect(prompt).not.toContain('<terms>')
  })
})
