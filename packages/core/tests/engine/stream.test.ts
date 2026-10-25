import { describe, expect, it } from 'vitest'
import { mapConcurrent } from '../../src/engine/stream.js'

async function* range(n: number): AsyncIterable<number> {
  for (let i = 0; i < n; i++) {
    yield i
  }
}

/** Hand-written async iterator with a `return` spy, so tests can assert the source is closed. */
function trackedSource(size: number): {
  source: AsyncIterable<number>
  wasReturned: () => boolean
} {
  let returned = false
  const source: AsyncIterable<number> = {
    [Symbol.asyncIterator](): AsyncIterator<number> {
      let i = 0
      return {
        next: async () =>
          i < size ? { value: i++, done: false } : { value: undefined, done: true },
        return: async () => {
          returned = true
          return { value: undefined, done: true }
        },
      }
    },
  }
  return { source, wasReturned: () => returned }
}

describe('mapConcurrent', () => {
  it('rejects non-finite concurrency instead of silently dropping all items', async () => {
    const stream = mapConcurrent(range(3), Number.NaN, async (i) => i)

    await expect(async () => {
      for await (const _ of stream) {
        // consume
      }
    }).rejects.toThrow(/concurrency/)
  })

  it('closes the source iterator when fn rejects', async () => {
    const { source, wasReturned } = trackedSource(5)

    await expect(async () => {
      for await (const _ of mapConcurrent(source, 2, async (i) => {
        if (i === 1) throw new Error('boom')
        return i
      })) {
        // consume
      }
    }).rejects.toThrow('boom')
    expect(wasReturned()).toBe(true)
  })

  it('closes the source iterator when the consumer stops early', async () => {
    const { source, wasReturned } = trackedSource(5)

    for await (const _ of mapConcurrent(source, 2, async (i) => i)) {
      break
    }

    expect(wasReturned()).toBe(true)
  })

  it('preserves order with concurrency 1', async () => {
    const results: number[] = []
    for await (const x of mapConcurrent(range(5), 1, async (i) => i * 2)) {
      results.push(x)
    }
    expect(results).toEqual([0, 2, 4, 6, 8])
  })

  it('preserves order with concurrency > 1', async () => {
    const results: number[] = []
    for await (const x of mapConcurrent(range(5), 3, async (i) => i)) {
      results.push(x)
    }
    expect(results).toEqual([0, 1, 2, 3, 4])
  })

  it('limits in-flight concurrency', async () => {
    let maxInFlight = 0
    let current = 0
    const concurrency = 3
    const sourceSize = 10

    async function* source() {
      for (let i = 0; i < sourceSize; i++) {
        yield i
      }
    }

    const fn = async (i: number) => {
      current++
      maxInFlight = Math.max(maxInFlight, current)
      await new Promise((resolve) => setTimeout(resolve, 10))
      current--
      return i
    }

    for await (const _ of mapConcurrent(source(), concurrency, fn)) {
      // consume
    }

    expect(maxInFlight).toBe(concurrency)
  })

  it('pulls lazily (backpressure)', async () => {
    let pulled = 0
    const concurrency = 2

    async function* source() {
      for (let i = 0; i < 5; i++) {
        pulled++
        yield i
      }
    }

    const fn = async (i: number) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return i
    }

    const iter = mapConcurrent(source(), concurrency, fn)[Symbol.asyncIterator]()
    await iter.next()
    // Initial window filled; first result returned. Not everything pulled yet.
    expect(pulled).toBeGreaterThanOrEqual(concurrency)
    expect(pulled).toBeLessThan(5)

    await iter.next()
    // A replacement was pulled after the first result freed a slot.
    expect(pulled).toBeGreaterThanOrEqual(concurrency + 1)
    expect(pulled).toBeLessThan(5)

    // consume rest
    while ((await iter.next()).done !== true) {
      // no-op
    }
    expect(pulled).toBe(5)
  })

  it('drops undefined results', async () => {
    const results: number[] = []
    for await (const x of mapConcurrent(range(5), 2, async (i) => (i % 2 === 0 ? i : undefined))) {
      results.push(x)
    }
    expect(results).toEqual([0, 2, 4])
  })

  it('propagates errors', async () => {
    const stream = mapConcurrent(range(3), 2, async (i) => {
      if (i === 1) throw new Error('boom')
      return i
    })

    const results: number[] = []
    await expect(async () => {
      for await (const x of stream) {
        results.push(x)
      }
    }).rejects.toThrow('boom')
    expect(results).toEqual([0])
  })
})
