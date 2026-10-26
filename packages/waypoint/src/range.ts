import type { Envelope, ParsedUri } from '@mt/core'
import type { Source, SourceContext } from '@mt/core'
import { registry } from '@mt/core'
import { resumeFrom } from './resume.js'

/**
 * Generate a stream of integers from `start` to `end` (inclusive), one envelope
 * per number: `{ item: n, meta: {} }`.
 *
 * URI scheme: range://<start>..<end>
 * Examples:
 *   range://1..10        → 1, 2, … 10
 *   range://5..3         → 5, 4, 3 (direction derived from start/end comparison)
 *   range://1..10?step=3 → 1, 4, 7, 10 (step is a positive-integer magnitude)
 *
 * `range://0..0` emits a single envelope.
 */
export function createRangeSource(uri: ParsedUri): Source<number> {
  const raw = uri.path || uri.host
  const sep = raw.indexOf('..')
  if (sep === -1) {
    throw new Error(`invalid range source URI "${uri.raw}": missing ".." separator`)
  }

  const startText = raw.slice(0, sep)
  const endText = raw.slice(sep + 2)

  const start = parseInteger(startText, 'start', uri.raw)
  const end = parseInteger(endText, 'end', uri.raw)

  let step = 1
  const stepText = uri.query.step
  if (stepText !== undefined) {
    step = parseInteger(stepText, 'step', uri.raw)
    if (step <= 0) {
      throw new Error(`invalid range source URI "${uri.raw}": step must be a positive integer`)
    }
  }

  const direction = start <= end ? 1 : -1

  const generate = async function* (): AsyncIterable<Envelope<number>> {
    for (let n = start; direction > 0 ? n <= end : n >= end; n += direction * step) {
      yield { item: n, meta: {} }
    }
  }

  return {
    uri: uri.raw,
    lifestyle: 'resumable',
    async *start(_ctx: SourceContext): AsyncIterable<Envelope<number>> {
      yield* generate()
    },
    async *resume(_ctx: SourceContext, cursor: unknown): AsyncIterable<Envelope<number>> {
      yield* resumeFrom(generate, cursor)
    },
  }
}

function parseInteger(text: string, component: string, raw: string): number {
  const value = Number(text)
  if (text.trim() === '' || !Number.isInteger(value)) {
    throw new Error(
      `invalid range source URI "${raw}": ${component} must be an integer, got "${text}"`,
    )
  }
  return value
}

// Register built-in range source (source-only: no target registration)
registry.registerSource('range', createRangeSource)
