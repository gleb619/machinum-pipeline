import { createExchange } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_VAL_PERCENT, datasetSplit, hashBucket, splitDataset } from './dataset-split.js'

const ctx = {} as ToolContext

function dataset(count: number): string[] {
  return Array.from({ length: count }, (_, i) => JSON.stringify({ i, text: `record ${i}` }))
}

function ids(jsonl: string): number[] {
  return jsonl
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as { i: number }).i)
}

describe('hashBucket', () => {
  it('is deterministic and lands in 0..99', () => {
    expect(hashBucket('{"i":1}')).toBe(hashBucket('{"i":1}'))
    expect(hashBucket('{"i":1}')).toBeGreaterThanOrEqual(0)
    expect(hashBucket('{"i":1}')).toBeLessThan(100)
  })
})

describe('splitDataset', () => {
  const records = dataset(200)
  const jsonl = `${records.join('\n')}\n`

  it('splits 3% to validation by default and accounts for every record', () => {
    const result = splitDataset(jsonl)

    expect(result.stats.valPercent).toBe(DEFAULT_VAL_PERCENT)
    expect(result.stats.recordsIn).toBe(200)
    expect(result.stats.trainCount + result.stats.valCount).toBe(200)
    expect(result.stats.valCount).toBeGreaterThan(0)
    expect(result.stats.valCount).toBeLessThan(200)
    expect(ids(result.train)).toHaveLength(result.stats.trainCount)
    expect(ids(result.val)).toHaveLength(result.stats.valCount)
  })

  it('is stable across runs (no randomness)', () => {
    const a = splitDataset(jsonl)
    const b = splitDataset(jsonl)
    expect(b).toEqual(a)
  })

  it('assigns by record content, so reordering the file does not move records between splits', () => {
    const forward = splitDataset(jsonl)
    const backward = splitDataset([...records].reverse().join('\n'))

    expect(new Set(ids(backward.val))).toEqual(new Set(ids(forward.val)))
    expect(new Set(ids(backward.train))).toEqual(new Set(ids(forward.train)))
    // input order is preserved inside each split
    expect(ids(forward.train)).toEqual([...ids(forward.train)].sort((a, b) => a - b))
  })

  it('honours explicit valPercent bounds: 0 keeps everything in train, 100 in val', () => {
    const none = splitDataset(jsonl, { valPercent: 0 })
    expect(none.val).toBe('')
    expect(none.stats.valCount).toBe(0)
    expect(none.stats.trainCount).toBe(200)

    const all = splitDataset(jsonl, { valPercent: 100 })
    expect(all.train).toBe('')
    expect(all.stats.trainCount).toBe(0)
    expect(all.stats.valCount).toBe(200)
  })

  it('rejects an out-of-range valPercent naming the option', () => {
    expect(() => splitDataset(jsonl, { valPercent: -1 })).toThrow(
      'dataset-split: valPercent must be a number between 0 and 100',
    )
    expect(() => splitDataset(jsonl, { valPercent: Number.NaN })).toThrow('valPercent')
  })

  it('rejects a line that is not valid JSON, naming the line number', () => {
    expect(() => splitDataset('{"a":1}\n{oops\n')).toThrow(
      'dataset-split: line 2 is not valid JSON',
    )
  })

  it('skips blank lines and keeps a trailing newline in each non-empty split', () => {
    const result = splitDataset(`\n${jsonl}\n`)
    expect(result.stats.recordsIn).toBe(200)
    expect(result.train.endsWith('\n')).toBe(true)
  })
})

describe('datasetSplit tool', () => {
  it('returns { train, val } and records the counts in meta', async () => {
    const out = await datasetSplit.invoke(createExchange(`${dataset(50).join('\n')}\n`), ctx)

    expect(out.item.train.split('\n').filter((l) => l !== '')).toHaveLength(
      out.meta.trainCount as number,
    )
    expect(out.meta).toMatchObject({ recordsIn: 50, valPercent: DEFAULT_VAL_PERCENT })
    expect((out.meta.trainCount as number) + (out.meta.valCount as number)).toBe(50)
  })

  it('passes an empty dataset through as two empty splits', async () => {
    const out = await datasetSplit.invoke(createExchange(''), ctx)
    expect(out.item).toEqual({ train: '', val: '' })
    expect(out.meta).toMatchObject({ recordsIn: 0, trainCount: 0, valCount: 0 })
  })
})
