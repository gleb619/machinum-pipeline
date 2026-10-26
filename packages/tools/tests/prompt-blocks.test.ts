import { describe, expect, it } from 'vitest'
import { getDefaultPrompt, registerPrompt } from '../src/core/llm-prompts.js'
import {
  PROMPT_WORK_MODES,
  StructuredReplyParseError,
  buildLlmPrompt,
  composePromptBlocks,
  extractPropertiesEntries,
  extractXmlResultEntries,
  parseStructuredReply,
  wrapPromptInput,
} from '../src/core/prompt-blocks.js'

describe('work modes', () => {
  it('exposes the three global work modes', () => {
    expect(PROMPT_WORK_MODES).toEqual(['plain', 'xml', 'properties'])
  })
})

describe('wrapPromptInput', () => {
  it('plain stays unwrapped', () => {
    expect(wrapPromptInput('one', 'plain')).toBe('one')
  })

  it('xml wraps each line as <result><id>N</id><origin>…</origin></result>', () => {
    expect(wrapPromptInput('one', 'xml')).toBe(
      '<context>\n<result><id>1</id><origin>one</origin></result>\n</context>',
    )
    expect(wrapPromptInput('one\ntwo', 'xml')).toBe(
      '<context>\n<result><id>1</id><origin>one</origin></result>\n' +
        '<result><id>2</id><origin>two</origin></result>\n</context>',
    )
  })

  it('properties wraps each line as N=text', () => {
    expect(wrapPromptInput('one\ntwo', 'properties')).toBe('<context>\n1=one\n2=two\n</context>')
  })
})

describe('composePromptBlocks', () => {
  it('composes translate.system + global llm.format.<mode> + translate.output.<mode>', () => {
    const plain = composePromptBlocks('translate', 'plain', {
      sourceLang: 'English',
      targetLang: 'Russian',
      text: 'Hello.',
      glossaryBlock: '',
      summaryBlock: '',
      extraRules: '',
      mode: 'plain',
    })
    expect(plain.complete).toBe(true)
    expect(plain.systemPrompt).toContain('You are a professional literary translator')
    expect(plain.systemPrompt).toContain('Input format (plain mode)')
    expect(plain.systemPrompt).toContain('Output contract (plain mode)')
    expect(plain.userPrompt).toBe('Hello.')

    const xml = composePromptBlocks('translate', 'xml', {
      sourceLang: 'English',
      targetLang: 'Russian',
      text: 'a\nb',
      glossaryBlock: '',
      summaryBlock: '',
      extraRules: '',
      mode: 'xml',
    })
    expect(xml.complete).toBe(true)
    expect(xml.systemPrompt).toContain('Input format (xml mode)')
    expect(xml.systemPrompt).toContain('Output contract (xml mode)')
    expect(xml.userPrompt).toBe(
      '<context>\n<result><id>1</id><origin>a</origin></result>\n' +
        '<result><id>2</id><origin>b</origin></result>\n</context>',
    )
  })

  it('composes the summary family with the named bullet output block', () => {
    const composed = composePromptBlocks(
      'summary',
      'plain',
      { text: 'body' },
      {
        output: 'summary.output.bullets',
      },
    )
    expect(composed.complete).toBe(true)
    expect(composed.systemPrompt).toContain('Web Novel Summary Notes Generator')
    expect(composed.systemPrompt).toContain('Input format (plain mode)')
    expect(composed.systemPrompt).toContain('Output contract (bullet-list mode)')
    expect(composed.userPrompt).toBe('body')
  })

  it('marks the composition incomplete when a family block is missing (format block still renders)', () => {
    const composed = composePromptBlocks('no-such-family', 'plain', { text: 'x' })
    expect(composed.complete).toBe(false)
    expect(composed.systemPrompt).toContain('Input format (plain mode)')
    expect(composed.userPrompt).toBe('x')
  })

  it('falls back to the single <family>.output block when the mode block is absent', () => {
    registerPrompt({ name: 'famx.system', template: 'SYS' })
    registerPrompt({ name: 'famx.output', template: 'OUT' })
    const composed = composePromptBlocks('famx', 'xml', { text: 'x' })
    expect(composed.complete).toBe(true)
    expect(composed.systemPrompt).toBe(
      ['SYS', getDefaultPrompt('llm.format.xml')?.template, 'OUT'].join('\n\n'),
    )
  })

  it('buildLlmPrompt folds the text into the vars', () => {
    const composed = buildLlmPrompt('translate', {
      text: 'Hi.',
      mode: 'properties',
      vars: {
        sourceLang: 'English',
        targetLang: 'Russian',
        glossaryBlock: '',
        summaryBlock: '',
        extraRules: '',
        mode: 'properties',
      },
    })
    expect(composed.userPrompt).toBe('<context>\n1=Hi.\n</context>')
    expect(composed.complete).toBe(true)
  })
})

describe('parseStructuredReply', () => {
  it('xml: tolerates think blocks and prose around the XML, sorts by id', () => {
    const reply =
      'Sure, here you go:\n<think>hm</think>\n' +
      '<result><id>2</id><translated>Second.</translated></result>\n' +
      'prose in between\n' +
      '<result><id>1</id><translated>First.</translated></result>\n' +
      'Done!'
    expect(parseStructuredReply(reply, 'xml')).toEqual(['First.', 'Second.'])
  })

  it('xml: throws a retryable error on missing ids and duplicates', () => {
    expect(() =>
      parseStructuredReply(
        '<result><id>1</id><translated>One.</translated></result>' +
          '<result><id>3</id><translated>Three.</translated></result>',
        'xml',
      ),
    ).toThrow(/missing id\/key 2/)
    expect(() =>
      parseStructuredReply(
        '<result><id>1</id><translated>One.</translated></result>' +
          '<result><id>1</id><translated>Again.</translated></result>',
        'xml',
      ),
    ).toThrow(/duplicate id\/key 1/)
  })

  it('properties: parses N=value lines, sorts by key, skips prose', () => {
    expect(parseStructuredReply('2=Second.\n1=First.\n\nHere you go!', 'properties')).toEqual([
      'First.',
      'Second.',
    ])
  })

  it('throws a retryable StructuredReplyParseError when nothing parseable was returned', () => {
    try {
      parseStructuredReply('no xml here', 'xml')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredReplyParseError)
      expect((err as StructuredReplyParseError).retryable).toBe(true)
    }
    expect(() => parseStructuredReply('nothing', 'properties')).toThrow(/no result blocks/)
  })

  it('extracts proofread-style blocks via the valueTag option (shared with the proofread tools)', () => {
    const reply = `<?xml version="1.0" encoding="UTF-8"?>
<results>
  <result>
    <id>1</id>
    <proofread>She does not like apples.</proofread>
  </result>
</results>`
    expect(parseStructuredReply(reply, 'xml', { valueTag: 'proofread' })).toEqual([
      'She does not like apples.',
    ])
    expect(extractXmlResultEntries(reply, 'proofread')).toEqual([
      { key: 1, value: 'She does not like apples.' },
    ])
  })

  it('extractPropertiesEntries unescapes Java-properties values on request', () => {
    expect(extractPropertiesEntries('1=She does not\\=like\\napples.', { unescape: true })).toEqual(
      [{ key: 1, value: 'She does not=like\napples.' }],
    )
    expect(extractPropertiesEntries('1=a=b')).toEqual([{ key: 1, value: 'a=b' }])
  })
})
