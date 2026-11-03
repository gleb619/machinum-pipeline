import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { activeRuns } from '../src/handlers.js'
import { drainActiveRuns, startMcpServer } from '../src/server.js'

/**
 * Track a background run the way `runPipeline` does: the run leaves the set
 * once it settles.
 */
function trackBackgroundRun(ms: number): { settled: () => boolean } {
  let isSettled = false
  const promise = new Promise<void>((resolve) => {
    setTimeout(() => {
      isSettled = true
      resolve()
    }, ms)
  })
  const tracked = promise.finally(() => {
    activeRuns.delete(tracked)
  })
  activeRuns.add(tracked)
  return { settled: () => isSettled }
}

describe('background run drain', () => {
  afterEach(() => {
    activeRuns.clear()
  })

  it('returns immediately when no run is active', async () => {
    await expect(drainActiveRuns()).resolves.toBeUndefined()
  })

  it('waits for tracked background runs before returning', async () => {
    const run = trackBackgroundRun(50)

    const drained = drainActiveRuns()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(run.settled()).toBe(false)

    await drained
    expect(run.settled()).toBe(true)
  })

  it('keeps the server alive until a background run settles when stdin closes', async () => {
    const run = trackBackgroundRun(50)

    // A client that disconnects at once: stdin ends without a request.
    const input = new PassThrough()
    input.end()

    let serverDone = false
    const server = startMcpServer(input).then(() => {
      serverDone = true
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(serverDone).toBe(false)

    await server
    expect(serverDone).toBe(true)
    expect(run.settled()).toBe(true)
  })
})
