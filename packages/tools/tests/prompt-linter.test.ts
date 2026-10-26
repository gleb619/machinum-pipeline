import { describe, expect, it } from 'vitest'
import { BUNDLED_PROMPTS } from '../src/generated/prompts.js'
import { TRANSLATE_ALLOWED_TEMPLATE_VARS } from '../src/normalization/translation-prompt.js'
import {
  lintPromptSet,
  lintPromptTemplate,
  lintTranslatePromptSet,
} from '../src/verification/prompt-linter.js'

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

describe('lintPromptSet', () => {
  it('passes on the real bundled translate set (translate.* + global llm.format.*)', () => {
    const translate = Object.fromEntries(
      Object.entries(BUNDLED_PROMPTS).filter(
        ([name]) => name.startsWith('translate.') || name.startsWith('llm.format.'),
      ),
    )
    expect(Object.keys(translate).sort()).toEqual([
      'llm.format.plain',
      'llm.format.properties',
      'llm.format.xml',
      'translate.output.plain',
      'translate.output.properties',
      'translate.output.xml',
      'translate.system',
    ])
    expect(
      lintPromptSet('translate', translate, { allowedVars: TRANSLATE_ALLOWED_TEMPLATE_VARS }),
    ).toEqual([])
  })

  it('passes on the real bundled summary set (summary.* + global llm.format.*)', () => {
    const summary = Object.fromEntries(
      Object.entries(BUNDLED_PROMPTS).filter(
        ([name]) => name.startsWith('summary.') || name.startsWith('llm.format.'),
      ),
    )
    expect(
      lintPromptSet('summary', summary, { modes: ['plain'], output: 'summary.output.bullets' }),
    ).toEqual([])
  })

  it('passes on the real bundled proofread prompts with the proofread builder vars', () => {
    const issues = Object.entries(BUNDLED_PROMPTS)
      .filter(([name]) => name.startsWith('proofread.'))
      .flatMap(([name, text]) =>
        lintPromptTemplate(name, text, { allowedVars: ['language', 'text'] }),
      )
    expect(issues).toEqual([])
  })

  it('passes on the real bundled llm.format.* blocks (no vars needed)', () => {
    for (const mode of ['plain', 'xml', 'properties'] as const) {
      const name = `llm.format.${mode}` as keyof typeof BUNDLED_PROMPTS
      expect(lintPromptTemplate(name, BUNDLED_PROMPTS[name])).toEqual([])
    }
  })

  it('flags a missing mode block and an empty one', () => {
    const translate: Record<string, string> = {
      'translate.system': 'Translate {{text}} from {{sourceLang}} to {{targetLang}}.',
      'llm.format.plain': 'plain format',
      'translate.output.plain': 'plain output',
      'llm.format.xml': '   ',
      'translate.output.xml': 'xml output',
      'llm.format.properties': 'properties format',
      // translate.output.properties missing
    }
    const issues = lintPromptSet('translate', translate)
    expect(
      issues.some((i) => i.rule === 'empty-template' && /properties' is missing/.test(i.message)),
    ).toBe(true)
    expect(
      issues.some(
        (i) =>
          i.rule === 'empty-template' && /'llm\.format\.xml' is missing or empty/.test(i.message),
      ),
    ).toBe(true)
  })

  it('accepts the single <family>.output fallback when the mode-specific block is absent', () => {
    const fam: Record<string, string> = {
      'fam.system': 'SYS',
      'llm.format.xml': 'FMT',
      'fam.output': 'OUT',
    }
    expect(lintPromptSet('fam', fam, { modes: ['xml'] })).toEqual([])
  })

  it('flags placeholders outside the builder var set in any family template', () => {
    const goodBlocks: Record<string, string> = {
      'llm.format.plain': 'f',
      'translate.output.plain': 'o',
      'llm.format.xml': 'f',
      'translate.output.xml': 'o',
      'llm.format.properties': 'f',
      'translate.output.properties': 'o',
    }
    const issues = lintPromptSet('translate', goodBlocks, {
      allowedVars: TRANSLATE_ALLOWED_TEMPLATE_VARS,
    })
    // translate.system itself is missing here
    expect(
      issues.some((i) => i.rule === 'empty-template' && /'translate\.system'/.test(i.message)),
    ).toBe(true)
    const withBogus = lintPromptSet(
      'translate',
      {
        ...goodBlocks,
        'translate.system': 'Translate {{text}} from {{sourceLang}} to {{bogus}}.',
      },
      { allowedVars: TRANSLATE_ALLOWED_TEMPLATE_VARS },
    )
    expect(withBogus.some((i) => i.rule === 'unknown-var' && /\{\{bogus\}\}/.test(i.message))).toBe(
      true,
    )
    // and a fully valid set (all builder vars used) passes
    const valid = lintPromptSet(
      'translate',
      {
        ...goodBlocks,
        'translate.system':
          'Translate {{text}} from {{sourceLang}} to {{targetLang}} for {{mode}}.\n{{glossaryBlock}}\n{{summaryBlock}}\n{{extraRules}}',
      },
      { allowedVars: TRANSLATE_ALLOWED_TEMPLATE_VARS },
    )
    expect(valid).toEqual([])
  })
})

describe('lintTranslatePromptSet', () => {
  it('delegates to lintPromptSet with the translate builder var set', () => {
    const translate = Object.fromEntries(
      Object.entries(BUNDLED_PROMPTS).filter(
        ([name]) => name.startsWith('translate.') || name.startsWith('llm.format.'),
      ),
    )
    expect(lintTranslatePromptSet(translate)).toEqual([])
  })
})
