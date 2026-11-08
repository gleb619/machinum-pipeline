import { category, defineTool, tool, withItem, withMeta } from '@mt/core'
import type { Exchange, ExchangeMeta, ToolContext } from '@mt/core'
import { readCount, readNumber } from '../core/values.js'

/**
 * Renders a markdown dataset card from dataset statistics (TL257).
 *
 * The stats come from the item (`DatasetCardStats`) and fall back to the envelope metadata
 * written by `datasetSplit` / `sftTriples` / `parallelPairs` (`recordsOut`, `trainCount`,
 * `valCount`, `chars`, `tokens`, `sources`, `licence`, `intendedUse`). The card states record
 * counts, the character total and a token estimate (chars / 4 when no token count was measured),
 * the source breakdown, the licence note and the intended use, and ends with a fenced `json`
 * block holding the same numbers for machine reading.
 */

/** Default licence note when none is supplied. */
export const DEFAULT_LICENCE_NOTE =
  'Not specified. Check the licence of every source corpus before redistributing the dataset or a model trained on it.'

/** Default intended-use note when none is supplied. */
export const DEFAULT_INTENDED_USE =
  'Fine-tuning a text model for the machinum-pipeline protocol (translation, proofreading, summaries, glossary and schema extraction). Not for general chat or unrelated domains.'

/** Average characters per token used for the estimate when no token count is given. */
const CHARS_PER_TOKEN = 4

/** Statistics a dataset card can be built from; every field is optional and may come from meta. */
export interface DatasetCardStats {
  /** Dataset name, used as the card title. */
  name?: string
  /** One-paragraph description shown under the title. */
  description?: string
  /** Total records (train + validation). */
  records?: number
  train?: number
  val?: number
  /** Total characters across all records. */
  chars?: number
  /** Measured token count; estimated from `chars` when absent. */
  tokens?: number
  /** Record counts per source (`{ book1: 120, book2: 80 }`). */
  sources?: Record<string, number>
  licence?: string
  intendedUse?: string
  /** Source -> target language pair of the data, e.g. `en -> ru`. */
  language?: string
}

/** Stats after meta fallback and estimate resolution. */
export interface ResolvedDatasetCardStats extends DatasetCardStats {
  records: number
  tokens?: number
  /** True when `tokens` was estimated from `chars` rather than measured. */
  tokensEstimated: boolean
}

/**
 * Fills the item stats from `meta` (item wins), derives `records` from `train` + `val` when
 * missing and estimates tokens from characters. Throws when there is not even a record count.
 */
export function resolveCardStats(
  stats: DatasetCardStats,
  meta: ExchangeMeta = {},
): ResolvedDatasetCardStats {
  const records = stats.records ?? readCount(meta.recordsOut) ?? readCount(meta.recordsIn)
  const train = stats.train ?? readCount(meta.trainCount)
  const val = stats.val ?? readCount(meta.valCount)
  const resolved =
    records ?? (train !== undefined || val !== undefined ? (train ?? 0) + (val ?? 0) : undefined)

  if (resolved === undefined) {
    throw new Error(
      'dataset-card: no record count available; set `records` (or `train` + `val`) on the item, ' +
        'or run the card after a stage that writes `meta.recordsOut` / `meta.trainCount`',
    )
  }
  if (train !== undefined && val !== undefined && train + val > resolved) {
    throw new Error(
      `dataset-card: train + val (${train + val}) exceeds records (${resolved}); pass consistent counts`,
    )
  }

  const chars = stats.chars ?? readCount(meta.chars)
  const measured = stats.tokens ?? readCount(meta.tokens)
  const tokens = measured ?? estimateTokens(chars)

  return {
    ...stats,
    records: resolved,
    train,
    val,
    chars,
    tokens,
    tokensEstimated: measured === undefined && tokens !== undefined,
    sources: stats.sources ?? readNumberRecord(meta.sources),
    licence: stats.licence ?? readText(meta.licence),
    intendedUse: stats.intendedUse ?? readText(meta.intendedUse),
    language: stats.language ?? readText(meta.language),
  }
}

/** Token estimate used when no measured count is available: `ceil(chars / 4)`. */
export function estimateTokens(chars: number | undefined): number | undefined {
  if (chars === undefined) return undefined
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function readText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

function readNumberRecord(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    const n = readCount(entry)
    if (n !== undefined) out[key] = n
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** Thousands-separated integer (locale independent). */
function grouped(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function share(count: number, total: number): string {
  if (total <= 0) return '—'
  return `${((count / total) * 100).toFixed(1)}%`
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

function sourceRows(sources: Record<string, number>, total: number): string[] {
  const entries = Object.entries(sources).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return entries.map(
    ([name, count]) => `| ${escapeCell(name)} | ${grouped(count)} | ${share(count, total)} |`,
  )
}

/** Machine-readable companion of the card; keys are emitted in a fixed order. */
function statsPayload(stats: ResolvedDatasetCardStats): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  if (stats.name !== undefined) payload.name = stats.name
  payload.records = stats.records
  if (stats.train !== undefined) payload.train = stats.train
  if (stats.val !== undefined) payload.val = stats.val
  if (stats.train !== undefined && stats.val !== undefined && stats.records > 0) {
    payload.valPercent = Math.round((stats.val / stats.records) * 10000) / 100
  }
  if (stats.chars !== undefined) payload.chars = stats.chars
  if (stats.tokens !== undefined) payload.tokens = stats.tokens
  if (stats.language !== undefined) payload.language = stats.language
  if (stats.sources !== undefined) {
    payload.sources = Object.fromEntries(
      Object.entries(stats.sources).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    )
  }
  payload.licence = stats.licence ?? DEFAULT_LICENCE_NOTE
  payload.intendedUse = stats.intendedUse ?? DEFAULT_INTENDED_USE
  return payload
}

/** Pure renderer: resolved stats -> markdown card with a fenced JSON stats block. */
export function buildDatasetCard(stats: ResolvedDatasetCardStats): string {
  const lines: string[] = [`# ${stats.name ?? 'Dataset card'}`, '']
  if (stats.description !== undefined) lines.push(stats.description, '')

  lines.push('## Summary', '', '| Field | Value |', '| --- | --- |')
  lines.push(`| Records | ${grouped(stats.records)} |`)
  if (stats.train !== undefined) {
    lines.push(`| Train | ${grouped(stats.train)} |`)
  }
  if (stats.val !== undefined) {
    lines.push(`| Validation | ${grouped(stats.val)} (${share(stats.val, stats.records)}) |`)
  }
  if (stats.chars !== undefined) lines.push(`| Characters | ${grouped(stats.chars)} |`)
  if (stats.tokens !== undefined) {
    const label = stats.tokensEstimated ? 'Tokens (estimate)' : 'Tokens'
    lines.push(`| ${label} | ${grouped(stats.tokens)} |`)
  }
  if (stats.language !== undefined) {
    lines.push(`| Language | ${escapeCell(stats.language)} |`)
  }
  lines.push('')

  if (stats.sources !== undefined) {
    lines.push(
      '## Source breakdown',
      '',
      '| Source | Records | Share |',
      '| --- | --- | --- |',
      ...sourceRows(stats.sources, stats.records),
      '',
    )
  }

  lines.push(
    '## Licence',
    '',
    stats.licence ?? DEFAULT_LICENCE_NOTE,
    '',
    'Check the upstream corpus licences (and the base-model licence of anything trained on the ' +
      'dataset) before publishing or redistributing it.',
    '',
    '## Intended use',
    '',
    stats.intendedUse ?? DEFAULT_INTENDED_USE,
    '',
    '## Stats',
    '',
    '```json',
    JSON.stringify(statsPayload(stats), null, 2),
    '```',
    '',
  )

  return lines.join('\n')
}

/**
 * Builds a markdown dataset card (record counts, character total, token estimate, source
 * breakdown, licence note, intended use) plus a fenced `json` stats block from the item stats
 * and the envelope meta written by the dataset-generation tools.
 */
export const datasetCard = defineTool<DatasetCardStats, string>({
  name: 'dataset-card',
  version: '1.0.0',
  mdDescription:
    'Renders a markdown dataset card from dataset stats (counts, chars, token estimate, source breakdown, licence, intended use) plus a fenced JSON stats block.',
  annotations: [
    tool('TL257', {
      name: 'dataset-card',
      description: 'Renders a markdown dataset card with a fenced JSON stats block.',
      refs: [],
    }),
    category(['serializer']),
  ],
  async invoke(env: Exchange<DatasetCardStats>, _ctx: ToolContext): Promise<Exchange<string>> {
    if (typeof env.item !== 'object' || env.item === null) {
      throw new Error(
        'dataset-card: item must be a stats object (`{ records, chars, sources, licence, ... }`); ' +
          'the counts may come from meta instead of the item',
      )
    }
    const stats = resolveCardStats(env.item, env.meta)
    return withMeta(withItem(env, buildDatasetCard(stats)), {
      cardRecords: stats.records,
      cardTokens: stats.tokens,
    })
  },
})
