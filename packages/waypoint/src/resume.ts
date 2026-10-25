/**
 * Shared resume helpers for `lifestyle: 'resumable'` waypoint sources.
 *
 * Runner contract (docs/steering/core.md): on resume the runner passes the
 * number of source envelopes the target already accepted, and the new cursor
 * is `sourceStart + envelopesWritten`. A `resume(ctx, cursor)` implementation
 * must therefore skip exactly `cursor` envelopes of the source's deterministic
 * ordering — replaying them would double-process while the runner believes
 * they were done, and the next resume would skip work that never ran.
 */

/**
 * Skip the first `n` envelopes of a stream.
 */
export async function* skipEnvelopes<T>(stream: AsyncIterable<T>, n: number): AsyncIterable<T> {
  let seen = 0
  for await (const env of stream) {
    if (seen++ < n) continue
    yield env
  }
}

/**
 * Resume from a source's `start()` stream, skipping `cursor` envelopes.
 * A non-number (or non-positive) cursor means "skip nothing".
 */
export async function* resumeFrom<T>(
  start: () => AsyncIterable<T>,
  cursor: unknown,
): AsyncIterable<T> {
  const skip =
    typeof cursor === 'number' && Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0
  yield* skipEnvelopes(start(), skip)
}
