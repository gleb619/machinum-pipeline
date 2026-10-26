import { describe, expect, it } from 'vitest'
import { BUNDLED_PROMPTS } from '../src/generated/prompts.js'
import { lintPromptTemplate, lintTranslatePromptSet } from '../src/verification/prompt-linter.js'

describe('lintPromptTemplate', () => {
  it('passes a good template', () => {
    const text = 'Translate from {{sourceLang}} to {{targetLang}}.\n\nText:\n{{text}}'
    expect(
      lintPromptTemplate('good', text, { allowedVars: ['sourceLang', 'targetLang', 'text'] }),
    ).toEqual([])
  })

  it('flags an empty template', () => {
    expect(lintPromptTemplate('empty', '  \n ')).toEqual([
      { rule: 'empty-template', message: "prompt 'empty' is empty" },
    ])
  })

  it('flags single-brace ST-style vars with the fix hint', () => {
    const issues = lintPromptTemplate('st', 'Translate:\n<context>\n{text}\n</context>')
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('single-brace-var')
    expect(issues[0]?.message).toContain('{text}: use {{text}}')
    expect(issues[0]?.line).toBe(3)
  })

  it('ignores single-brace vars inside fenced code blocks', () => {
    const text = 'Rules:\n\n```\n{"term": "value"}\n```\n\nTranslate {{text}}.'
    expect(lintPromptTemplate('fence', text, { allowedVars: ['text'] })).toEqual([])
  })

  it('flags unbalanced braces', () => {
    const issues = lintPromptTemplate('unbalanced', 'Translate {{text to {{targetLang}}.')
    expect(issues.some((i) => i.rule === 'placeholder-syntax')).toBe(true)
  })

  it('flags invalid placeholder names', () => {
    const issues = lintPromptTemplate('bad-name', 'Translate {{2bad}} and {{target-lang}}.')
    expect(issues.filter((i) => i.rule === 'placeholder-syntax')).toHaveLength(1)
    expect(issues[0]?.message).toContain('{{2bad}}')
  })

  it('flags triple braces', () => {
    const issues = lintPromptTemplate('triple', 'Translate {{{text}}}.')
    expect(
      issues.some((i) => i.rule === 'placeholder-syntax' && /triple braces/.test(i.message)),
    ).toBe(true)
  })

  it('flags unknown vars when allowedVars is provided', () => {
    const issues = lintPromptTemplate('unknown', 'A {{known}} B {{mystery}}.', {
      allowedVars: ['known'],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('unknown-var')
    expect(issues[0]?.message).toContain('{{mystery}}')
  })

  it('accepts the dotted/underscore var naming used by the toolkit', () => {
    const text = '{{json.correction}} {{validation_correction}} {{a.b-c_d}}'
    expect(lintPromptTemplate('dotted', text)).toEqual([])
  })
})

describe('lintTranslatePromptSet', () => {
  it('passes on the real bundled translate.* templates', () => {
    const translate = Object.fromEntries(
      Object.entries(BUNDLED_PROMPTS).filter(([name]) => name.startsWith('translate.')),
    )
    expect(Object.keys(translate).sort()).toEqual([
      'translate.format.plain',
      'translate.format.properties',
      'translate.format.xml',
      'translate.output.plain',
      'translate.output.properties',
      'translate.output.xml',
      'translate.system',
    ])
    expect(lintTranslatePromptSet(translate)).toEqual([])
  })

  it('flags a missing mode block and an empty one', () => {
    const translate: Record<string, string> = {
      'translate.system': 'Translate {{text}} from {{sourceLang}} to {{targetLang}}.',
      'translate.format.plain': 'plain format {{text}}',
      'translate.output.plain': 'plain output',
      'translate.format.xml': '   ',
      'translate.output.xml': 'xml output',
      'translate.format.properties': 'properties format',
      // translate.output.properties missing
    }
    const issues = lintTranslatePromptSet(translate)
    expect(
      issues.some((i) => i.rule === 'empty-template' && /properties' is missing/.test(i.message)),
    ).toBe(true)
    expect(
      issues.some(
        (i) =>
          i.rule === 'empty-template' &&
          /'translate\.format\.xml' is missing or empty/.test(i.message),
      ),
    ).toBe(true)
  })

  it('flags placeholders outside the builder var set in any translate.* template', () => {
    const goodBlocks: Record<string, string> = {
      'translate.format.plain': 'f',
      'translate.output.plain': 'o',
      'translate.format.xml': 'f',
      'translate.output.xml': 'o',
      'translate.format.properties': 'f',
      'translate.output.properties': 'o',
    }
    const issues = lintTranslatePromptSet({
      ...goodBlocks,
      'translate.system': 'Translate {{text}} from {{sourceLang}} to {{bogus}}.',
    })
    expect(issues.some((i) => i.rule === 'unknown-var' && /\{\{bogus\}\}/.test(i.message))).toBe(
      true,
    )
    // and a fully valid set (all builder vars used) passes
    const valid = lintTranslatePromptSet({
      ...goodBlocks,
      'translate.system':
        'Translate {{text}} from {{sourceLang}} to {{targetLang}} for {{mode}}.\n{{glossaryBlock}}\n{{summaryBlock}}\n{{extraRules}}',
    })
    expect(valid).toEqual([])
  })
})
