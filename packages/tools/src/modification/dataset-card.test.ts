import { createExchange } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INTENDED_USE,
  DEFAULT_LICENCE_NOTE,
  buildDatasetCard,
  datasetCard,
  estimateTokens,
  resolveCardStats,
} from './dataset-card.js'
import type { DatasetCardStats } from './dataset-card.js'

const ctx = {} as ToolContext

function jsonBlock(card: string): Record<string, unknown> {
  const match = card.match(/```json\n([\s\S]*?)\n```/)
  if (!match?.[1]) throw new Error('dataset card has no fenced json block')
  return JSON.parse(match[1]) as Record<string, unknown>
}

describe('estimateTokens', () => {
  it('estimates one token per four characters, rounding up', () => {
    expect(estimateTokens(4000)).toBe(1000)
    expect(estimateTokens(4001)).toBe(1001)
    expect(estimateTokens(undefined)).toBeUndefined()
  })
})

describe('resolveCardStats', () => {
  it('falls back to the meta written by the dataset tools', () => {
    const stats = resolveCardStats(
      {},
      { recordsOut: 100, trainCount: 97, valCount: 3, chars: 400, sources: { book1: 100 } },
    )

    expect(stats).toMatchObject({
      records: 100,
      train: 97,
      val: 3,
      chars: 400,
      tokens: 100,
      tokensEstimated: true,
      sources: { book1: 100 },
    })
  })

  it('lets item fields win over meta and derives records from train + val', () => {
    const stats = resolveCardStats({ records: 10, chars: 80, tokens: 33 }, { recordsOut: 100 })
    expect(stats).toMatchObject({ records: 10, chars: 80, tokens: 33, tokensEstimated: false })

    expect(resolveCardStats({ train: 9, val: 1 }, {}).records).toBe(10)
  })

  it('throws when there is no record count anywhere', () => {
    expect(() => resolveCardStats({}, {})).toThrow('dataset-card: no record count available')
  })

  it('throws when train + val exceeds records', () => {
    expect(() => resolveCardStats({ records: 5, train: 5, val: 2 }, {})).toThrow(
      'dataset-card: train + val (7) exceeds records (5)',
    )
  })
})

describe('buildDatasetCard', () => {
  const stats: DatasetCardStats = {
    name: 'book1-en-ru',
    description: 'Paragraph pairs from book one.',
    records: 1200,
    train: 1164,
    val: 36,
    chars: 480_000,
    sources: { book1: 900, book2: 300 },
    licence: 'CC-BY-4.0 for the source text.',
    intendedUse: 'EN->RU literary translation fine-tuning.',
    language: 'en -> ru',
  }

  it('renders the summary, sources, licence and intended use', () => {
    const card = buildDatasetCard(resolveCardStats(stats, {}))

    expect(card.startsWith('# book1-en-ru')).toBe(true)
    expect(card).toContain('| Records | 1,200 |')
    expect(card).toContain('| Train | 1,164 |')
    expect(card).toContain('| Validation | 36 (3.0%) |')
    expect(card).toContain('| Characters | 480,000 |')
    expect(card).toContain('| Tokens (estimate) | 120,000 |')
    expect(card).toContain('| book1 | 900 | 75.0% |')
    expect(card).toContain('| book2 | 300 | 25.0% |')
    expect(card).toContain('CC-BY-4.0 for the source text.')
    expect(card).toContain('EN->RU literary translation fine-tuning.')
    expect(card).toContain('Check the upstream corpus licences')
  })

  it('ends with a fenced json stats block that parses', () => {
    const payload = jsonBlock(buildDatasetCard(resolveCardStats(stats, {})))

    expect(payload).toMatchObject({
      name: 'book1-en-ru',
      records: 1200,
      train: 1164,
      val: 36,
      valPercent: 3,
      chars: 480_000,
      tokens: 120_000,
      licence: 'CC-BY-4.0 for the source text.',
      intendedUse: 'EN->RU literary translation fine-tuning.',
      language: 'en -> ru',
    })
    expect(payload.sources).toEqual({ book1: 900, book2: 300 })
  })

  it('uses the default licence and intended-use notes when none are given', () => {
    const card = buildDatasetCard(resolveCardStats({ records: 3 }, {}))
    expect(card).toContain(DEFAULT_LICENCE_NOTE)
    expect(card).toContain(DEFAULT_INTENDED_USE)
    expect(jsonBlock(card).licence).toBe(DEFAULT_LICENCE_NOTE)
  })

  it('escapes pipe characters in source names so the table stays valid', () => {
    const card = buildDatasetCard(resolveCardStats({ records: 1, sources: { 'a|b': 1 } }, {}))
    expect(card).toContain('| a\\|b | 1 | 100.0% |')
  })
})

describe('datasetCard tool', () => {
  it('renders the card from item stats and records counts in meta', async () => {
    const out = await datasetCard.invoke(createExchange({ records: 10, chars: 40 }), ctx)

    expect(out.meta).toMatchObject({ cardRecords: 10, cardTokens: 10 })
    expect(out.item).toContain('# Dataset card')
  })

  it('reads stats from meta when the item is empty', async () => {
    const ex = createExchange<DatasetCardStats>({}, { meta: { recordsOut: 20, chars: 80 } })
    const out = await datasetCard.invoke(ex, ctx)

    expect(out.item).toContain('| Records | 20 |')
    expect(jsonBlock(out.item)).toMatchObject({ records: 20, tokens: 20 })
  })

  it('rejects an item that is not a stats object', async () => {
    const item = 'records: 10' as unknown as DatasetCardStats
    await expect(datasetCard.invoke(createExchange(item), ctx)).rejects.toThrow(
      'dataset-card: item must be a stats object',
    )
  })
})
