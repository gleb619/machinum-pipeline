import { createExchange } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  MIN_PARALLEL_ALIGNMENT,
  ParallelPairsError,
  buildParallelPairs,
  parallelPairs,
  splitParagraphs,
} from './parallel-pairs.js'

const ctx = {} as ToolContext

const EN = [
  '---',
  'number: 1',
  '---',
  '',
  '# Chapter 1',
  '',
  'First paragraph.',
  '',
  'Second.',
  '',
  'Third one.',
].join('\n')
const RU = [
  '---',
  'number: 1',
  '---',
  '',
  '# Глава 1',
  '',
  'Первый абзац.',
  '',
  'Второй.',
  '',
  'Третий.',
].join('\n')

function jsonlLines(jsonl: string): Array<Record<string, unknown>> {
  return jsonl
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('splitParagraphs', () => {
  it('drops frontmatter, heading-only and decorative-only blocks', () => {
    const markdown = [
      '---',
      'title: One',
      '---',
      '',
      '# Chapter 1',
      '',
      'Prose.',
      '',
      '***',
      '',
      '## Scene two',
      '',
      'More prose.',
    ].join('\n')

    const { paragraphs, dropped } = splitParagraphs(markdown)

    expect(paragraphs).toEqual(['Prose.', 'More prose.'])
    expect(dropped).toEqual({ empty: 0, heading: 3, frontmatter: 1 })
  })

  it('keeps a paragraph that merely starts with a heading', () => {
    const { paragraphs } = splitParagraphs('## Scene\n\nBody text.')
    expect(paragraphs).toEqual(['Body text.'])
  })
})

describe('buildParallelPairs', () => {
  it('pairs equal paragraph counts 1:1 with stable ids, chars and ratio', () => {
    const result = buildParallelPairs({ en: EN, ru: RU })

    expect(result.pairs).toHaveLength(3)
    expect(result.stats).toMatchObject({
      pairs: 3,
      aligned: 3,
      paragraphsEn: 3,
      paragraphsRu: 3,
      alignmentShare: 1,
    })

    const first = result.pairs[0]
    expect(first?.src).toBe('First paragraph.')
    expect(first?.tgt).toBe('Первый абзац.')
    expect(first?.id).toMatch(/^[0-9a-f]{12}$/)
    expect(first?.chars).toBe('First paragraph.'.length + 'Первый абзац.'.length)
    expect(first?.ratio).toBe(0.813)
    expect(jsonlLines(result.jsonl)[0]).toEqual({
      id: first?.id,
      src: 'First paragraph.',
      tgt: 'Первый абзац.',
      chars: first?.chars,
      ratio: 0.813,
    })
  })

  it('is deterministic: the same chapter yields the same ids on every run', () => {
    const a = buildParallelPairs({ en: EN, ru: RU })
    const b = buildParallelPairs({ en: EN, ru: RU })
    expect(b.pairs.map((p) => p.id)).toEqual(a.pairs.map((p) => p.id))
  })

  it('throws a retryable error when fewer than 60% of the paragraphs align', () => {
    const ru = ['Первый абзац.'].join('\n')

    let error: unknown
    try {
      buildParallelPairs({ en: EN, ru })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ParallelPairsError)
    const failure = error as ParallelPairsError
    expect(failure.retryable).toBe(true)
    expect(failure.share).toBeCloseTo(1 / 3, 5)
    expect(failure.enParagraphs).toBe(3)
    expect(failure.ruParagraphs).toBe(1)
    expect(failure.message).toContain('33.3% of paragraphs align')
    expect(failure.message).toContain(`${(MIN_PARALLEL_ALIGNMENT * 100).toFixed(0)}%`)
  })

  it('keeps the aligned prefix when the mismatch is above the threshold', () => {
    const ru = ['Первый абзац.', 'Второй.', 'Третий.', 'Лишний.'].join('\n\n')
    const result = buildParallelPairs({ en: EN, ru })
    expect(result.pairs).toHaveLength(3)
    expect(result.stats.alignmentShare).toBe(0.75)
  })
})

describe('parallelPairs tool', () => {
  it('accepts the chapter as a JSON string item and writes stats into meta', async () => {
    const out = await parallelPairs.invoke(createExchange(JSON.stringify({ en: EN, ru: RU })), ctx)

    expect(out.meta).toMatchObject({
      pairs: 3,
      alignmentShare: 1,
      paragraphsEn: 3,
      paragraphsRu: 3,
    })
    expect(jsonlLines(out.item)).toHaveLength(3)
  })

  it('accepts a pre-parsed object item', async () => {
    const out = await parallelPairs.invoke(createExchange({ en: EN, ru: RU }), ctx)
    expect(jsonlLines(out.item)).toHaveLength(3)
  })

  it('rejects malformed items with an actionable message', async () => {
    await expect(parallelPairs.invoke(createExchange('{oops'), ctx)).rejects.toThrow(
      'parallel-pairs: item is not valid JSON',
    )
    await expect(
      parallelPairs.invoke(
        createExchange({ en: 'x' } as unknown as { en: string; ru: string }),
        ctx,
      ),
    ).rejects.toThrow('parallel-pairs: item must be `{ en, ru }` chapter markdown')
  })
})
