import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'

import { normalizeText, textNormalizer } from '../src/normalization/text-normalizer.js'

describe('normalizeText', () => {
  it('unifies curly quotes', () => {
    expect(normalizeText('“Hi,” she said. It’s ‘fine’.')).toBe("\"Hi,\" she said. It's 'fine'.")
  })

  it('unifies dashes and ellipsis', () => {
    expect(normalizeText('a–b -- c… d. . . e')).toBe('a—b—c... d... e')
  })

  it('strips zero-width and control characters', () => {
    expect(normalizeText('a​b﻿c\u0007d e')).toBe('abcd e')
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
})
