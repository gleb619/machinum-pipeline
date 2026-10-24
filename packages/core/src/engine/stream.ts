/**
 * Ordered, bounded async map over a stream.
 *
 * - Preserves input order in output (when `ordered: true`, the default).
 * - Keeps at most `concurrency` items in flight.
 * - Pulls from `source` lazily: a new item is requested only when a slot frees up.
 * - Drops `undefined` results, allowing callers to represent skipped items.
 */
export async function* mapConcurrent<T, U>(
  source: AsyncIterable<T>,
  concurrency: number,
  fn: (item: T) => Promise<U | undefined>,
  options: { ordered?: boolean } = {},
): AsyncIterable<U> {
  const n = Math.max(1, Math.floor(Number(concurrency)))
  const ordered = options.ordered ?? true
  const iter = source[Symbol.asyncIterator]()
  const pending: { index: number; promise: Promise<void>; result?: U; error?: unknown }[] = []
  let nextIndex = 0
  let done = false

  const pull = async (): Promise<{ value: T; index: number } | null> => {
    if (done) return null
    const result = await iter.next()
    if (result.done) {
      done = true
      return null
    }
    return { value: result.value, index: nextIndex++ }
  }

  const start = (value: T, index: number) => {
    const slot: { index: number; promise: Promise<void>; result?: U; error?: unknown } = {
      index,
      promise: Promise.resolve(),
    }
    slot.promise = fn(value).then(
      (result) => {
        slot.result = result
      },
      (error) => {
        slot.error = error
      },
    )
    pending.push(slot)
  }

  // Seed the initial window without exceeding the concurrency bound.
  while (pending.length < n) {
    const next = await pull()
    if (!next) break
    start(next.value, next.index)
  }

  if (ordered) {
    // Pending stays sorted by index, so the front is always the next output.
    while (pending.length > 0) {
      const head = pending[0]
      if (!head) break
      await head.promise
      pending.shift()

      const next = await pull()
      if (next) start(next.value, next.index)

      if (head.error !== undefined) throw head.error
      if (head.result !== undefined) yield head.result
    }
  } else {
    while (pending.length > 0) {
      const settled = await Promise.race(pending.map((slot, i) => slot.promise.then(() => i)))
      const slot = pending[settled]
      if (!slot) break
      pending.splice(settled, 1)

      const next = await pull()
      if (next) start(next.value, next.index)

      if (slot.error !== undefined) throw slot.error
      if (slot.result !== undefined) yield slot.result
    }
  }
}
