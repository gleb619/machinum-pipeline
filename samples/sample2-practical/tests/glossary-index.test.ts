import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type GlossaryIndexInput,
  PRIOR_TERMS_HEADER,
  PRIOR_TERMS_MAX,
  buildGlossaryIndex,
  priorTermsMax,
  renderPriorTerms,
} from '@mt/bookkit'
import { describe, expect, it } from 'vitest'

function fixture(): { chaptersDir: string; glossary: GlossaryIndexInput } {
  const chaptersDir = mkdtempSync(join(tmpdir(), 'mt-glossary-index-'))
  mkdirSync(join(chaptersDir, 'en'), { recursive: true })
  writeFileSync(
    join(chaptersDir, 'en', 'chapter1.md'),
    '# Chapter 1\n\nArin walked in. Arin left. Ash watched.\n',
  )
  writeFileSync(join(chaptersDir, 'en', 'chapter2.md'), '# Chapter 2\n\nArin met Bren.\n')
  writeFileSync(join(chaptersDir, 'en', 'chapter3.md'), '# Chapter 3\n\nCora found Bren.\n')
  return {
    chaptersDir,
    glossary: {
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
          id: 'bren',
          term: 'Bren',
          type: 'character',
          count: 2,
          firstChapter: 2,
          ru: 'Брен',
          aliases: [],
        },
        {
          id: 'cora',
          term: 'Cora',
          type: 'place',
          count: 1,
          firstChapter: 3,
          ru: 'Кора',
          aliases: [],
        },
        {
          id: 'ghost',
          term: 'Ghost',
          type: 'character',
          count: 0,
          firstChapter: null,
          ru: 'Призрак',
          aliases: [],
        },
        {
          id: 'ash',
          term: 'Ash',
          type: 'character',
          count: 1,
          firstChapter: 1,
          ru: 'Эш',
          aliases: [],
          ignored: true,
        },
      ],
    },
  }
}

describe('buildGlossaryIndex', () => {
  it('maps every active term to the chapters it occurs in', async () => {
    const { chaptersDir, glossary } = fixture()
    const index = await buildGlossaryIndex({ chaptersDir, glossary })
    const byTerm = (term: string) => index.terms.find((entry) => entry.term === term)

    expect(byTerm('Arin')).toMatchObject({
      id: 'arin',
      type: 'character',
      ru: 'Арин',
      chapters: [1, 2],
      firstChapter: 1,
      count: 3,
    })
    expect(byTerm('Bren')).toMatchObject({ chapters: [2, 3], firstChapter: 2, count: 2 })
    expect(byTerm('Cora')).toMatchObject({ chapters: [3], firstChapter: 3, count: 1 })
  })

  it('drops hallucinated (count 0) and ignored terms', async () => {
    const { chaptersDir, glossary } = fixture()
    const index = await buildGlossaryIndex({ chaptersDir, glossary })
    expect(index.terms.map((term) => term.term)).toEqual(['Arin', 'Bren', 'Cora'])
  })

  it('is deterministic across runs', async () => {
    const { chaptersDir, glossary } = fixture()
    const first = await buildGlossaryIndex({ chaptersDir, glossary })
    const second = await buildGlossaryIndex({ chaptersDir, glossary })
    expect(second).toEqual(first)
  })
})

describe('renderPriorTerms', () => {
  it('renders nothing for chapter 1', async () => {
    const { chaptersDir, glossary } = fixture()
    const index = await buildGlossaryIndex({ chaptersDir, glossary })
    expect(renderPriorTerms(index, 1)).toBe('')
  })

  it('renders only terms first seen before the chapter', async () => {
    const { chaptersDir, glossary } = fixture()
    const index = await buildGlossaryIndex({ chaptersDir, glossary })
    const block = renderPriorTerms(index, 2)
    expect(block.startsWith(PRIOR_TERMS_HEADER)).toBe(true)
    expect(block).toContain('- Arin → Арин')
    expect(block).not.toContain('Bren')
    expect(block).not.toContain('Cora')
  })

  it('respects the term cap', async () => {
    const { chaptersDir, glossary } = fixture()
    const index = await buildGlossaryIndex({ chaptersDir, glossary })
    const block = renderPriorTerms(index, 4, { maxTerms: 2 })
    expect(block.split('\n')).toHaveLength(3)
    expect(block).toContain('Arin')
    expect(block).toContain('Bren')
    expect(block).not.toContain('Cora')
  })

  it('reads MT_PRIOR_TERMS_MAX with the 40-term default', () => {
    expect(priorTermsMax({})).toBe(PRIOR_TERMS_MAX)
    expect(priorTermsMax({ MT_PRIOR_TERMS_MAX: '7' })).toBe(7)
    expect(priorTermsMax({ MT_PRIOR_TERMS_MAX: 'nope' })).toBe(PRIOR_TERMS_MAX)
  })
})
