import { createHash } from 'node:crypto'
import { category, defineTool, tool, withItem, withMeta } from '@mt/core'
import type { Exchange, ToolContext } from '@mt/core'
import { errorMessage } from '../core/values.js'

/**
 * Deterministic train/validation split of a JSONL dataset (TL256).
 *
 * A record goes to validation when `sha256(record) mod 100 < valPercent` (default 3). The hash
 * is taken over the record text itself, so the split is reproducible across runs, machines and
 * record order - reordering the file moves nothing, and adding records does not reshuffle the
 * existing ones. No randomness, no seed to lose. Records keep their input order inside each
 * split, so `train + val` reads like the input minus the validation rows.
 *
 * Blank lines are skipped (not counted); a line that is not valid JSON throws with its 1-based
 * line number instead of being silently moved to one side.
 */

/** Default share of records that goes to validation, in percent. */
export const DEFAULT_VAL_PERCENT = 3

/** Options for {@link splitDataset}. */
export interface DatasetSplitOptions {
  /** Validation share in percent, `0..100`. Default 3. */
  valPercent?: number
}

/** Output item: both splits as JSONL text. */
export interface DatasetSplitOutput {
  /** Records with `hash mod 100 >= valPercent`, input order. */
  train: string
  /** Records with `hash mod 100 < valPercent`, input order. */
  val: string
}

/** Envelope metadata written by the tool. */
export interface DatasetSplitStats {
  /** Non-blank input records. */
  recordsIn: number
  trainCount: number
  valCount: number
  valPercent: number
}

/** Result of the pure split. */
export interface DatasetSplitResult extends DatasetSplitOutput {
  stats: DatasetSplitStats
}

/** `sha256(record) mod 100`, the stable bucket of one record. */
export function hashBucket(record: string): number {
  return createHash('sha256').update(record).digest().readUInt32BE(0) % 100
}

function readValPercent(value: number | undefined): number {
  if (value === undefined) return DEFAULT_VAL_PERCENT
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(
      `dataset-split: valPercent must be a number between 0 and 100, got ${JSON.stringify(value)}; ` +
        `pass e.g. { valPercent: ${DEFAULT_VAL_PERCENT} }`,
    )
  }
  return value
}

/**
 * Pure split: JSONL text -> `{ train, val, stats }`. Deterministic per record; throws on an
 * invalid `valPercent` or a line that is not valid JSON.
 */
export function splitDataset(jsonl: string, options: DatasetSplitOptions = {}): DatasetSplitResult {
  const valPercent = readValPercent(options.valPercent)
  const train: string[] = []
  const val: string[] = []
  let recordsIn = 0

  for (const [index, raw] of jsonl.split('\n').entries()) {
    const line = raw.trim()
    if (line === '') continue
    try {
      JSON.parse(line)
    } catch (error) {
      throw new Error(
        `dataset-split: line ${index + 1} is not valid JSON (${errorMessage(error)}); fix or filter the record before splitting so neither split receives a broken row`,
      )
    }
    recordsIn += 1
    if (hashBucket(line) < valPercent) val.push(line)
    else train.push(line)
  }

  return {
    train: train.length === 0 ? '' : `${train.join('\n')}\n`,
    val: val.length === 0 ? '' : `${val.join('\n')}\n`,
    stats: { recordsIn, trainCount: train.length, valCount: val.length, valPercent },
  }
}

/**
 * Splits a JSONL dataset into train and validation by `sha256(record) mod 100 < valPercent`
 * (default 3). Deterministic and order-independent per record, with no randomness anywhere;
 * `recordsIn`, `trainCount`, `valCount` and `valPercent` land in meta.
 */
export const datasetSplit = defineTool<string, DatasetSplitOutput>({
  name: 'dataset-split',
  version: '1.0.0',
  mdDescription:
    'Deterministic hash split of JSONL into `{ train, val }` by `sha256(record) mod 100 < valPercent` (default 3); no randomness, stable across runs, counts in meta.',
  annotations: [
    tool('TL256', {
      name: 'dataset-split',
      description: 'Splits JSONL into train/validation deterministically by record hash.',
      refs: [],
    }),
    category(['splitter']),
  ],
  async invoke(env: Exchange<string>, _ctx: ToolContext): Promise<Exchange<DatasetSplitOutput>> {
    if (typeof env.item !== 'string') {
      throw new Error(
        'dataset-split: item must be a JSONL string (one JSON record per line); ' +
          'run it on the output of a dataset-generation tool',
      )
    }
    const { train, val, stats } = splitDataset(env.item)
    return withMeta(withItem(env, { train, val }), { ...stats })
  },
})
