import { describe, expect, it } from 'vitest'
import { assertSummaryIsShort, summaryBullets } from './summary-bullets.js'

describe('summaryBullets', () => {
  it('keeps a dash-bullet block as-is', () => {
    const block = '- First line.\n- Second line.'
    expect(summaryBullets(block)).toEqual(['- First line.', '- Second line.'])
  })

  it('turns a paragraph into one bullet per sentence', () => {
    expect(
      summaryBullets('The first event happened today. Then the second event happened.'),
    ).toEqual(['- The first event happened today.', '- Then the second event happened.'])
  })

  it('keeps a single sentence as one bullet', () => {
    expect(summaryBullets('The archive keeps one recovered tape.')).toEqual([
      '- The archive keeps one recovered tape.',
    ])
  })

  it('returns no bullets for blank input', () => {
    expect(summaryBullets('   \n\n')).toEqual([])
  })
})

describe('assertSummaryIsShort', () => {
  const markdown = `# Chapter 9: Test\n\n${Array.from({ length: 80 }, () => 'word').join(' ')}`

  it('fails an empty summary and names the chapter', () => {
    expect(() => assertSummaryIsShort(9, 'Chapter 9: Test', '', markdown)).toThrow(
      /chapter 9.*empty/i,
    )
  })

  it('fails a whole-chapter copy', () => {
    const whole = Array.from({ length: 60 }, () => 'word').join(' ')
    expect(() => assertSummaryIsShort(9, 'Chapter 9: Test', whole, markdown)).toThrow(
      /chapter 9.*25 %/i,
    )
  })

  it('returns the bullets of a short summary', () => {
    expect(assertSummaryIsShort(9, 'Chapter 9: Test', 'A short summary.', markdown)).toEqual([
      '- A short summary.',
    ])
  })
})
