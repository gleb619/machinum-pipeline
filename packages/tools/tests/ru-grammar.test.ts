import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { exchangeOf } from './exchange-helper.js'

import { parseGlossary, serializeGlossary } from '../src/normalization/glossary-extractor.js'
import {
  RU_CASES,
  createRuGrammarTool,
  declineAllRu,
  declineRu,
  inferRuGrammar,
  inferRuGrammarForGlossary,
  validateRuInflection,
} from '../src/normalization/ru-grammar.js'
import type { RuCase, RuGrammar } from '../src/normalization/ru-grammar.js'
import type { Glossary } from '../src/normalization/term-tagger.js'

const CTX = {} as ToolContext

const NOUNS = ['стол', 'книга', 'слово', 'ночь', 'пальто'] as const

type TableNoun = (typeof NOUNS)[number]

const SINGULAR: Record<TableNoun, string[]> = {
  стол: ['стол', 'стола', 'столу', 'стол', 'столом', 'столе'],
  книга: ['книга', 'книги', 'книге', 'книгу', 'книгой', 'книге'],
  слово: ['слово', 'слова', 'слову', 'слово', 'словом', 'слове'],
  ночь: ['ночь', 'ночи', 'ночи', 'ночь', 'ночью', 'ночи'],
  пальто: ['пальто', 'пальто', 'пальто', 'пальто', 'пальто', 'пальто'],
}

const PLURAL: Record<TableNoun, string[]> = {
  стол: ['столы', 'столов', 'столам', 'столы', 'столами', 'столах'],
  книга: ['книги', 'книг', 'книгам', 'книги', 'книгами', 'книгах'],
  слово: ['слова', 'слов', 'словам', 'слова', 'словами', 'словах'],
  ночь: ['ночи', 'ночей', 'ночам', 'ночи', 'ночами', 'ночах'],
  пальто: ['пальто', 'пальто', 'пальто', 'пальто', 'пальто', 'пальто'],
}

describe('inferRuGrammar', () => {
  it('classifies regular masculine, feminine, neuter nouns', () => {
    expect(inferRuGrammar('стол')).toMatchObject({ gender: 'm', declension: 2 })
    expect(inferRuGrammar('книга')).toMatchObject({ gender: 'f', declension: 1 })
    expect(inferRuGrammar('слово')).toMatchObject({ gender: 'n', declension: 2 })
    expect(inferRuGrammar('ночь')).toMatchObject({ gender: 'f', declension: 3 })
  })

  it('recognises a common borrowed indeclinable noun', () => {
    const g = inferRuGrammar('пальто')
    expect(g).toMatchObject({ declension: 'indeclinable' })
    expect(declineAllRu('пальто', g)).toEqual(
      Object.fromEntries(RU_CASES.map((c) => [c, { singular: 'пальто', plural: 'пальто' }])),
    )
  })

  it('falls back to indeclinable for non-cyrillic words', () => {
    expect(inferRuGrammar('Hobbit')).toMatchObject({ declension: 'indeclinable' })
  })
})

describe('declineRu', () => {
  it.each([
    ['стол', 'genitive', 'singular', 'стола'],
    ['книга', 'accusative', 'singular', 'книгу'],
    ['слово', 'instrumental', 'singular', 'словом'],
    ['ночь', 'instrumental', 'singular', 'ночью'],
    ['стол', 'dative', 'plural', 'столам'],
    ['книга', 'genitive', 'plural', 'книг'],
  ] as [string, RuCase, 'singular' | 'plural', string][])(
    'declines %s %s %s to %s',
    (word, c, n, expected) => {
      const grammar = inferRuGrammar(word)
      expect(declineRu(word, grammar, c, n)).toBe(expected)
    },
  )

  it('declines the whole paradigm for the table nouns', () => {
    for (const word of NOUNS) {
      const grammar = inferRuGrammar(word)
      const table = declineAllRu(word, grammar)
      const sg = SINGULAR[word]
      const pl = PLURAL[word]
      for (let i = 0; i < RU_CASES.length; i++) {
        const c = RU_CASES[i]
        if (!c) continue
        expect(table[c].singular).toBe(sg[i])
        expect(table[c].plural).toBe(pl[i])
      }
    }
  })
})

describe('validateRuInflection', () => {
  it('passes when only valid forms appear', () => {
    const glossary: Glossary = {
      terms: [
        {
          id: 'stol',
          term: 'Table',
          type: 'item',
          count: 1,
          firstChapter: 1,
          ru: 'стол',
          aliases: [],
          ruGrammar: inferRuGrammar('стол'),
        },
      ],
    }
    const report = validateRuInflection('На столе стоят столы.', glossary)
    expect(report.ok).toBe(true)
    expect(report.checked).toBe(1)
    expect(report.issues).toHaveLength(0)
  })

  it('flags a wrong ending as a deviation', () => {
    const glossary: Glossary = {
      terms: [
        {
          id: 'stol',
          term: 'Table',
          type: 'item',
          count: 1,
          firstChapter: 1,
          ru: 'стол',
          aliases: [],
          ruGrammar: inferRuGrammar('стол'),
        },
      ],
    }
    const report = validateRuInflection('столы здесь, а столям не место', glossary)
    expect(report.ok).toBe(false)
    expect(report.issues).toHaveLength(1)
    const issue = report.issues[0]
    expect(issue).toBeDefined()
    if (!issue) throw new Error('unreachable')
    expect(issue).toMatchObject({
      termId: 'stol',
      ru: 'стол',
      found: 'столям',
    })
    expect(issue.expected).toContain('столам')
    expect(issue.expected).not.toContain('столям')
  })
})

describe('glossary round-trip', () => {
  it('keeps ruGrammar through parse/serialize', () => {
    const grammar: RuGrammar = {
      gender: 'f',
      declension: 1,
      endings: inferRuGrammar('книга').endings,
    }
    const glossary: Glossary = {
      terms: [
        {
          id: 'book',
          term: 'Book',
          type: 'item',
          count: 2,
          firstChapter: 1,
          ru: 'книга',
          aliases: [],
          ruGrammar: grammar,
        },
      ],
      ignored: [],
      rejected: [],
    }
    const parsed = parseGlossary(serializeGlossary(glossary))
    expect(parsed).toBeDefined()
    if (!parsed) throw new Error('unreachable')
    const term = parsed.terms[0]
    expect(term).toBeDefined()
    if (!term) throw new Error('unreachable')
    expect(term.ruGrammar).toEqual(grammar)
  })
})

describe('inferRuGrammarForGlossary', () => {
  it('adds grammar only when missing', () => {
    const grammar = inferRuGrammar('стол')
    const glossary: Glossary = {
      terms: [
        {
          id: 'table',
          term: 'Table',
          type: 'item',
          count: 1,
          firstChapter: 1,
          ru: 'стол',
          aliases: [],
        },
        {
          id: 'book',
          term: 'Book',
          type: 'item',
          count: 1,
          firstChapter: 1,
          ru: 'книга',
          aliases: [],
          ruGrammar: grammar,
        },
      ],
    }
    const enriched = inferRuGrammarForGlossary(glossary)
    const added = enriched.terms[0]
    expect(added).toBeDefined()
    if (!added) throw new Error('unreachable')
    expect(added.ruGrammar).toBeDefined()
    const kept = enriched.terms[1]
    expect(kept).toBeDefined()
    if (!kept) throw new Error('unreachable')
    expect(kept.ruGrammar).toEqual(grammar)
  })
})

describe('ruGrammarTool', () => {
  it('puts the validation report in meta.ruGrammar', async () => {
    const glossary: Glossary = {
      terms: [
        {
          id: 'book',
          term: 'Book',
          type: 'item',
          count: 1,
          firstChapter: 1,
          ru: 'книга',
          aliases: [],
          ruGrammar: inferRuGrammar('книга'),
        },
      ],
    }
    const tool = createRuGrammarTool()
    const out = await tool.invoke(exchangeOf('На книге лежат книги.', { glossary }), CTX)
    const report = getVariable(out, 'ruGrammar') as {
      ok: boolean
      checked: number
      issues: unknown[]
    }
    expect(report.ok).toBe(true)
    expect(report.checked).toBe(1)
    expect(report.issues).toHaveLength(0)
  })

  it('infers missing grammar and writes the glossary file atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mt-ru-grammar-'))
    try {
      const file = join(dir, 'glossary.json')
      const glossary: Glossary = {
        terms: [
          {
            id: 'book',
            term: 'Book',
            type: 'item',
            count: 1,
            firstChapter: 1,
            ru: 'книга',
            aliases: [],
          },
        ],
      }
      await writeFile(file, serializeGlossary(glossary))

      const tool = createRuGrammarTool({ glossaryFile: file, inferMissing: true })
      const out = await tool.invoke(
        { id: 'ex-test', variables: [], item: 'Книги лежат на столе.', meta: {} },
        CTX,
      )
      expect(getVariable(out, 'ruGrammar')).toBeDefined()

      const written = parseGlossary(await readFile(file, 'utf-8'))
      expect(written).toBeDefined()
      if (!written) throw new Error('unreachable')
      const term = written.terms[0]
      expect(term).toBeDefined()
      if (!term) throw new Error('unreachable')
      expect(term.ruGrammar).toMatchObject({ gender: 'f', declension: 1 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
