import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import {
  cleanSource,
  createTextNormalizer,
  normalizeText,
  textNormalizer,
} from '../src/normalization/text-normalizer.js'

describe('normalizeText', () => {
  it('unifies curly quotes', () => {
    expect(normalizeText('“Hi,” she said. It’s ‘fine’.')).toBe("\"Hi,\" she said. It's 'fine'.")
  })

  it('unifies dashes and ellipsis', () => {
    expect(normalizeText('a–b -- c… d. . . e')).toBe('a—b—c... d... e')
  })

  it('strips zero-width and control characters', () => {
    expect(normalizeText('a​b﻿c\u0007d e')).toBe('abcd e')
  })

  it('collapses spaces and repeated blank lines', () => {
    expect(normalizeText('\n\na   b\n\n\n\nc  \n\n')).toBe('a b\n\nc')
  })

  it('strips stray symbols but keeps bracketed system text', () => {
    expect(normalizeText('*Hello* ~world~ [System: level up!]')).toBe(
      'Hello world [System: level up!]',
    )
  })

  it('drops decorative lines', () => {
    expect(normalizeText('one\n* * *\n~~~~\ntwo')).toBe('one\ntwo')
    expect(normalizeText('one\n***\ntwo', { dropDecorativeLines: false })).toBe('one\n\ntwo')
  })

  it('fixes punctuation spacing', () => {
    expect(normalizeText('Wait ,what ?No!Yes ... ok.Next')).toBe('Wait, what? No! Yes... ok. Next')
  })

  it('leaves decimals and abbreviations alone', () => {
    expect(normalizeText('Pi is 3.14, e.g. 2.5x.')).toBe('Pi is 3.14, e.g. 2.5x.')
  })

  it('preserves the number of lines', () => {
    const input = 'one “a”\ntwo ,\nthree…'
    expect(normalizeText(input).split('\n')).toHaveLength(3)
  })

  it('is idempotent', () => {
    const once = normalizeText('“A” ,b…c\n\n\n*d*')
    expect(normalizeText(once)).toBe(once)
  })

  it('strips credit lines via string matching', () => {
    const input = 'Chapter 1\nTranslated by AI\nThe story begins.'
    const out = normalizeText(input, {
      stringsToRemove: ['translated by'],
    })
    expect(out).toBe('Chapter 1\nThe story begins.')
  })

  it('strips lines matching configured patterns', () => {
    const input = 'Start\nEditor: John\nMiddle\nCredit: Jane\nEnd'
    const out = normalizeText(input, {
      patternsToRemove: ['^\\s*(Editor|Credit):\\s*\\w+'],
    })
    expect(out).toBe('Start\nMiddle\nEnd')
  })

  it('strips Cloudflare email placeholder lines', () => {
    const input = 'Header\n[email protected]\nBody'
    const out = cleanSource(input, { stripCloudflareEmail: true })
    expect(out).toBe('Header\nBody')
  })

  it('dedupes repeated chapter-title lines', () => {
    const input = 'The Title\n\nThe Title\nFirst paragraph.'
    expect(cleanSource(input, { dedupeTitleLines: true })).toBe('The Title\n\nFirst paragraph.')
  })

  it('does not dedupe repeated body lines', () => {
    const input = 'Yes.\n\nYes.'
    expect(cleanSource(input, { dedupeTitleLines: true })).toBe('Yes.\n\nYes.')
  })
})

describe('cleanSource', () => {
  it('removes configured strings and patterns in one pass', () => {
    const input = 'A\nBETA\nC\nD'
    const out = cleanSource(input, {
      stringsToRemove: ['BETA'],
      patternsToRemove: ['^\\s*C\\s*$'],
    })
    expect(out).toBe('A\nD')
  })

  it('collapses blank lines by default', () => {
    expect(cleanSource('a\n\n\n\nb')).toBe('a\n\nb')
  })

  it('keeps blank runs when collapseBlankLines is false', () => {
    expect(cleanSource('a\n\n\nb', { collapseBlankLines: false })).toBe('a\n\n\nb')
  })
})

describe('textNormalizer tool', () => {
  it('normalizes and flags meta.normalized', async () => {
    const ctx = {} as ToolContext
    const changed = await textNormalizer.invoke(
      { id: 'ex-test', variables: [], item: '“x”', meta: { a: 1 } },
      ctx,
    )
    expect(changed.item).toBe('"x"')
    expect(changed.meta).toEqual({ a: 1 })
    expect(getVariable(changed, 'normalized')).toBe(true)
    const same = await textNormalizer.invoke(
      { id: 'ex-test', variables: [], item: 'x', meta: {} },
      ctx,
    )
    expect(getVariable(same, 'normalized')).toBe(false)
  })

  it('reports cleaning changes via the normalized variable', async () => {
    const normalizer = createTextNormalizer({ stringsToRemove: ['credit'] })
    const out = await normalizer.invoke(
      { id: 'ex-test', variables: [], item: 'line\nCredit line\nother', meta: {} },
      {} as ToolContext,
    )
    expect(out.item).toBe('line\nother')
    expect(getVariable(out, 'normalized')).toBe(true)
  })
})
