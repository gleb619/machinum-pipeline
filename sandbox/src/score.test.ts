import { describe, expect, it } from 'vitest'
import {
  cyrillicRatio,
  emptyOrEcho,
  glossaryHits,
  paragraphParity,
  paragraphParityExact,
  scoreTranslation,
} from './score.ts'

describe('paragraphParity', () => {
  it('1 for equal line counts, ignoring blanks', () => {
    expect(paragraphParity('a\nb', 'x\n\ny')).toBe(1)
    expect(paragraphParityExact('a\nb', 'x\ny')).toBe(true)
  })
  it('ratio for mismatch, 0 for empty side', () => {
    expect(paragraphParity('a\nb\nc\nd', 'x\ny')).toBe(0.5)
    expect(paragraphParity('a', '')).toBe(0)
    expect(paragraphParityExact('a', 'x\ny')).toBe(false)
  })
})

describe('glossaryHits', () => {
  const g = { Veyra: 'Вейра', 'Pale Choir': 'Бледный Хор' }
  it('counts only terms present in en when en is given', () => {
    expect(glossaryHits('Вейра идёт', g, 'Veyra walks')).toBe(1)
    expect(glossaryHits('Она идёт', g, 'Veyra walks')).toBe(0)
  })
  it('all terms when en omitted; partial hit', () => {
    expect(glossaryHits('Вейра', g)).toBe(0.5)
  })
  it('1 when no term applies', () => {
    expect(glossaryHits('текст', g, 'nothing here')).toBe(1)
  })
})

describe('cyrillicRatio', () => {
  it('pure cyrillic is 1, latin is 0, mixed between', () => {
    expect(cyrillicRatio('Привет, мир!')).toBe(1)
    expect(cyrillicRatio('Hello')).toBe(0)
    expect(cyrillicRatio('Привет hi')).toBeCloseTo(6 / 8)
    expect(cyrillicRatio('123 !!')).toBe(0)
  })
})

describe('emptyOrEcho', () => {
  it('detects blank and echo', () => {
    expect(emptyOrEcho('Hello world', '  ')).toBe(true)
    expect(emptyOrEcho('Hello world', 'hello   WORLD')).toBe(true)
    expect(emptyOrEcho('Hello world', 'Привет мир')).toBe(false)
  })
})

describe('scoreTranslation', () => {
  const glossary = { Veyra: 'Вейра' }
  it('perfect translation scores 1', () => {
    const r = scoreTranslation({ en: 'Veyra runs', ru: 'Вейра бежит', glossary })
    expect(r.score).toBeCloseTo(1)
  })
  it('echo scores 0', () => {
    const r = scoreTranslation({ en: 'Veyra runs', ru: 'Veyra runs', glossary })
    expect(r.failed).toBe(true)
    expect(r.score).toBe(0)
  })
  it('missing glossary lowers score', () => {
    const r = scoreTranslation({ en: 'Veyra runs', ru: 'Она бежит', glossary })
    expect(r.score).toBeCloseTo(0.7)
  })
})
