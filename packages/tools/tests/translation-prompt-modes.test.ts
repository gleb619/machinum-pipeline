import { describe, expect, it } from 'vitest'
import { loadBundledPrompt } from '../src/core/bundled-prompts.js'
import { type Glossary, buildTranslationPrompt, wrapTranslationInput } from '../src/index.js'
import {
  TranslationReplyParseError,
  parseTranslationReply,
} from '../src/normalization/translation-reply.js'

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
  ],
}

const TAGGED = '<term id="arin">Arin</term> met <term id="keep">Iron Keep</term>.'

describe('buildTranslationPrompt modes', () => {
  it('default (plain) mode composes system + format + output blocks and wraps the text', () => {
    const p = buildTranslationPrompt({ text: TAGGED, glossary })
    expect(p.systemPrompt).toContain(loadBundledPrompt('translate.system').split('{{')[0])
    expect(p.systemPrompt).toContain('Input format (plain mode)')
    expect(p.systemPrompt).toContain('Output contract (plain mode)')
    expect(p.systemPrompt).toContain('Arin = Арин')
    expect(p.systemPrompt).toContain('Iron Keep = Железная крепость')
    expect(p.userPrompt).toBe('<context>\nArin met Iron Keep.\n</context>')
  })

  it('xml mode wraps each line as <result><id>N</id><origin>…</origin></result>', () => {
    const p = buildTranslationPrompt({
      text: 'First line.\nSecond line.',
      glossary,
      mode: 'xml',
    })
    expect(p.systemPrompt).toContain('Input format (xml mode)')
    expect(p.systemPrompt).toContain('Output contract (xml mode)')
    expect(p.systemPrompt).toContain('Never omit any <result> element')
    expect(p.userPrompt).toBe(
      '<context>\n' +
        '<result><id>1</id><origin>First line.</origin></result>\n' +
        '<result><id>2</id><origin>Second line.</origin></result>\n' +
        '</context>',
    )
  })

  it('properties mode wraps each line as N=text', () => {
    const p = buildTranslationPrompt({
      text: 'First line.\nSecond line.',
      glossary,
      mode: 'properties',
    })
    expect(p.systemPrompt).toContain('Input format (properties mode)')
    expect(p.systemPrompt).toContain('Output contract (properties mode)')
    expect(p.userPrompt).toBe('<context>\n1=First line.\n2=Second line.\n</context>')
  })

  it('renders extra rules, glossary block and summary for every mode', () => {
    const p = buildTranslationPrompt({
      text: TAGGED,
      glossary,
      summary: 'A short summary.',
      extraRules: ['Rule one.'],
      mode: 'xml',
    })
    expect(p.systemPrompt).toContain('- Rule one.')
    expect(p.systemPrompt).toContain('Arin = Арин')
    expect(p.systemPrompt).toContain('A short summary.')
  })

  it('wrapTranslationInput handles empty-ish and single-line input', () => {
    expect(wrapTranslationInput('one', 'plain')).toBe('<context>\none\n</context>')
    expect(wrapTranslationInput('one', 'properties')).toBe('<context>\n1=one\n</context>')
    expect(wrapTranslationInput('one', 'xml')).toBe(
      '<context>\n<result><id>1</id><origin>one</origin></result>\n</context>',
    )
  })
})

describe('parseTranslationReply', () => {
  it('plain: cleans think/terms blocks and returns the lines', () => {
    const parsed = parseTranslationReply(
      '<think>hm</think>\nПервая строка.\n<terms>[]</terms>',
      'plain',
    )
    expect(parsed.lines).toEqual(['Первая строка.'])
  })

  it('xml: tolerates think blocks and prose around the XML, sorts by id', () => {
    const reply =
      'Sure, here is the translation:\n<think>let me translate…</think>\n' +
      '<result><id>2</id><translated>Вторая строка.</translated></result>\n' +
      'some prose note in between\n' +
      '<result><id>1</id><translated>Первая строка.</translated></result>\n' +
      'Done!'
    const parsed = parseTranslationReply(reply, 'xml')
    expect(parsed.lines).toEqual(['Первая строка.', 'Вторая строка.'])
  })

  it('xml: throws a retryable error on missing ids (gap in the id sequence)', () => {
    const reply =
      '<result><id>1</id><translated>Одна.</translated></result>' +
      '<result><id>3</id><translated>Три.</translated></result>'
    try {
      parseTranslationReply(reply, 'xml')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TranslationReplyParseError)
      expect((err as TranslationReplyParseError).retryable).toBe(true)
      expect((err as Error).message).toMatch(/missing id\/key 2/)
    }
  })

  it('xml: throws a retryable error on duplicate ids', () => {
    const reply =
      '<result><id>1</id><translated>Одна.</translated></result>' +
      '<result><id>1</id><translated>Снова одна.</translated></result>'
    expect(() => parseTranslationReply(reply, 'xml')).toThrow(TranslationReplyParseError)
    expect(() => parseTranslationReply(reply, 'xml')).toThrow(/duplicate id\/key 1/)
  })

  it('properties: parses N=translation lines, sorts by key', () => {
    const reply = '2=Вторая строка.\n1=Первая строка.\n\nHere you go!'
    const parsed = parseTranslationReply(reply, 'properties')
    expect(parsed.lines).toEqual(['Первая строка.', 'Вторая строка.'])
  })

  it('properties: keys must be contiguous 1..N (retryable error otherwise)', () => {
    expect(() => parseTranslationReply('2=Вторая.', 'properties')).toThrow(/missing id\/key 1/)
    expect(() => parseTranslationReply('1=Одна.\n1=Снова.', 'properties')).toThrow(
      /duplicate id\/key 1/,
    )
    const err = ((): unknown => {
      try {
        parseTranslationReply('3=Третья.', 'properties')
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(err).toBeInstanceOf(TranslationReplyParseError)
    expect((err as TranslationReplyParseError).retryable).toBe(true)
  })

  it('structured modes throw a retryable error when nothing parseable was returned', () => {
    expect(() => parseTranslationReply('no xml here', 'xml')).toThrow(TranslationReplyParseError)
    expect(() => parseTranslationReply('no keys here', 'properties')).toThrow(/no result blocks/)
  })
})

describe('backward compatibility', () => {
  it('default mode output matches the previous user prompt contract (tags stripped, text preserved)', () => {
    const p = buildTranslationPrompt({ text: TAGGED, glossary })
    expect(p.userPrompt).toBe(`<context>\n${'Arin met Iron Keep.'}\n</context>`)
    expect(p.userPrompt).toContain('Arin met Iron Keep.')
    expect(p.userPrompt).not.toContain('<term')
  })

  it('parseTranslationReply plain mode agrees with cleanTranslation', () => {
    const reply = '<think>x</think>\nСтрока один.\nСтрока два.'
    expect(parseTranslationReply(reply, 'plain').lines.join('\n')).toBe('Строка один.\nСтрока два.')
  })
})
