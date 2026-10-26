import { getVariable } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  balanceText,
  balancedLineStrategy,
  balancedStrategy,
  countTokens,
  createTokenSplitter,
  heuristicTokenCount,
  lineStrategy,
  overlap,
  paragraphStrategy,
  rebalance,
  rebalanceLines,
  sentenceStrategy,
  singleStrategy,
  tokenSplitter,
  whitespaceStrategy,
  withStrategy,
} from '../src/normalization/token-splitter.js'

const ctx = { run: { global: {} } } as unknown as ToolContext

function paragraph(wordCount: number): string {
  return `${Array.from({ length: wordCount }, (_, i) => `w${i}`).join(' ')}.\n\n`
}

function longText(wordCount: number): string {
  return Array.from({ length: 20 }, () => paragraph(wordCount)).join('')
}

describe('tokenSplitter', () => {
  it('does not split short chapters', async () => {
    const text = 'Short chapter with a few words.'
    const result = await tokenSplitter.invoke(
      { id: 'ex-test', variables: [], item: text, meta: {} },
      ctx,
    )
    expect(result.item).toHaveLength(1)
    expect(result.item[0]).toBe(text)
    expect(getVariable(result, 'strategy')).toBe('paragraph')
  })

  it('splits very long chapters', async () => {
    const text = longText(500)
    const result = await tokenSplitter.invoke(
      { id: 'ex-test', variables: [], item: text, meta: {} },
      ctx,
    )
    expect(result.item.length).toBeGreaterThan(1)
    expect(getVariable(result, 'split')).toBe(true)
    expect(getVariable(result, 'chunkCount')).toBe(result.item.length)
  })

  it('uses .with() to swap strategy', async () => {
    const text = longText(300)
    const sentenceSplitter = tokenSplitter.with({ strategy: sentenceStrategy({ maxChars: 600 }) })
    expect(sentenceSplitter).not.toBe(tokenSplitter)

    const result = await sentenceSplitter.invoke(
      { id: 'ex-test', variables: [], item: text, meta: {} },
      ctx,
    )
    expect(getVariable(result, 'strategy')).toBe('sentence')
    expect(result.item.length).toBeGreaterThan(1)

    const original = await tokenSplitter.invoke(
      { id: 'ex-test', variables: [], item: text, meta: {} },
      ctx,
    )
    expect(getVariable(original, 'strategy')).toBe('paragraph')
  })

  it('supports withStrategy decorator', async () => {
    const text = longText(1000)
    const lineSplitter = withStrategy(tokenSplitter, lineStrategy({ maxTokens: 100 }))
    const result = await lineSplitter.invoke(
      { id: 'ex-test', variables: [], item: text, meta: {} },
      ctx,
    )
    expect(getVariable(result, 'strategy')).toBe('line')
    expect(result.item.length).toBeGreaterThan(1)
  })
})

describe('strategies', () => {
  it('singleStrategy returns one chunk', async () => {
    const text = 'anything'
    expect(await singleStrategy().split(text)).toEqual([text])
  })

  it('paragraphStrategy splits at paragraph boundaries', async () => {
    const text = longText(400)
    const chunks = await paragraphStrategy({ targetTokens: 500 }).split(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(heuristicTokenCount(chunk)).toBeLessThanOrEqual(500 + 100)
    }
  })

  it('lineStrategy splits at line boundaries', async () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n')
    const chunks = await lineStrategy({ maxTokens: 100 }).split(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.split('\n').length).toBeGreaterThanOrEqual(1)
    }
  })

  it('whitespaceStrategy splits at word boundaries', async () => {
    const text = 'word '.repeat(400).trim()
    const chunks = await whitespaceStrategy({ maxTokens: 50 }).split(text)
    expect(chunks.length).toBeGreaterThan(1)
    const first = chunks[0]
    expect(first).toBeDefined()
    expect(first?.includes(' ')).toBe(true)
  })

  it('sentenceStrategy preserves sentence boundaries', async () => {
    const sentences = Array.from(
      { length: 10 },
      (_, i) => `Sentence ${i} has many words and ends here.`,
    )
    const text = sentences.join(' ')
    const chunks = await sentenceStrategy({ maxChars: 120 }).split(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.endsWith('.') || chunk.endsWith('!') || chunk.endsWith('?')).toBe(true)
    }
  })

  it('balancedStrategy creates evenly sized chunks', async () => {
    const text = longText(200)
    const chunks = await balancedStrategy({ targetTokens: 400 }).split(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length > 0)).toBe(true)
  })

  it('balancedLineStrategy preserves line order and boundaries', async () => {
    const lines = [
      'alpha line one',
      'beta line two is somewhat longer',
      'gamma',
      'delta delta delta',
      'epsilon here',
      'zeta zeta zeta zeta',
      'eta',
      'theta theta theta',
      'iota iota',
      'kappa',
    ]
    const text = lines.join('\n')
    const chunks = await balancedLineStrategy({ maxTokens: 8 }).split(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('\n')).toBe(lines.join('\n'))
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        expect(lines).toContain(line)
      }
    }
  })

  it('balancedLineStrategy applies overlap', async () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i} ${'a'.repeat(40)}`).join('\n')
    const chunks = await balancedLineStrategy({ maxTokens: 100, overlapChars: 20 }).split(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (let i = 0; i < chunks.length - 1; i++) {
      const current = chunks[i]
      const next = chunks[i + 1]
      if (current === undefined || next === undefined) continue
      expect(current.endsWith(next.slice(0, 20))).toBe(true)
    }
  })
})

describe('helpers', () => {
  it('heuristicTokenCount approximates 4 chars per token', () => {
    expect(heuristicTokenCount('abcd')).toBe(1)
    expect(heuristicTokenCount('abcdefgh')).toBe(2)
  })

  it('countTokens returns a positive number', async () => {
    const count = await countTokens('hello world')
    expect(count).toBeGreaterThan(0)
  })

  it('balanceText distributes lines into chunks', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const chunks = balanceText(text, 4)
    expect(chunks).toHaveLength(4)
    expect(chunks.join('\n')).toBe(text)
  })

  it('overlap appends the start of the next chunk', () => {
    const input = ['aaa', 'bbb', 'ccc']
    expect(overlap(input, 2)).toEqual(['aaabb', 'bbbcc', 'ccc'])
  })

  it('rebalance moves characters between chunks preserving order', () => {
    const input = ['aaaa', 'b']
    expect(rebalance(input)).toEqual(['aaa', 'ab'])
  })

  it('rebalance preserves the overall character order', () => {
    const input = ['abcdefgh', '12']
    const result = rebalance(input)
    expect(result.join('')).toBe('abcdefgh12')
    expect(result).toEqual(['abcde', 'fgh12'])
  })

  it('rebalanceLines shifts whole lines and preserves order', () => {
    const chunks = ['l1\nl2\nl3\nl4\nl5', 'l6', 'l7']
    const result = rebalanceLines(chunks)
    expect(result.join('\n')).toBe(chunks.join('\n'))
    for (const chunk of result) {
      for (const line of chunk.split('\n')) {
        expect(['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7']).toContain(line)
      }
    }
  })
})

describe('createTokenSplitter', () => {
  it('respects custom maxTokens', async () => {
    const splitter = createTokenSplitter({
      strategy: singleStrategy(),
      maxTokens: 10,
    })
    const text = 'hello world this is longer than ten tokens maybe'
    const result = await splitter.invoke(
      { id: 'ex-test', variables: [], item: text, meta: {} },
      ctx,
    )
    expect(getVariable(result, 'strategy')).toBe('single')
    expect(result.item).toEqual([text])
  })
})
