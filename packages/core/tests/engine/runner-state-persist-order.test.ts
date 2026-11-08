import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Runner } from '../../src/engine/runner.js'
import { createExchange } from '../../src/exchange.js'
import type { Pipeline } from '../../src/types.js'
import type { Exchange, GlobalContext } from '../../src/types.js'
import { registry } from '../../src/uri.js'

/**
 * Regression (T186): a finished run must never be observable as `running`.
 *
 * The Runner queued mid-run `state.json` snapshots without waiting for the
 * in-flight one, so a snapshot taken while the run was still `running` could
 * land on disk *after* the terminal `done` snapshot and overwrite it — the
 * observed write order was `running -> done -> running`.
 *
 * The race is made deterministic here: a `running` snapshot is slow to land, a
 * terminal one is fast, so the stale snapshot always finishes last.
 */
const writes = vi.hoisted(() => ({ completed: [] as string[] }))

vi.mock('../../src/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store.js')>()
  return {
    Store: class extends actual.Store {
      override async writeJson(data: unknown, ...parts: string[]): Promise<string> {
        const isState = parts.at(-1) === 'state.json'
        const state = isState ? (data as { state?: string }).state : undefined
        if (isState) {
          // Slow `running` snapshots, fast terminal ones: the snapshot queued
          // earlier finishes last on disk.
          await new Promise((resolve) => setTimeout(resolve, state === 'running' ? 200 : 0))
        }
        const path = await super.writeJson(data, ...parts)
        if (isState && state) writes.completed.push(state)
        return path
      }
    },
  }
})

registry.registerSource('persist-order-source', (u) => ({
  uri: u.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    yield createExchange('payload', { id: 'e1' })
  },
  async *resume() {
    yield createExchange('payload', { id: 'e1' })
  },
}))

registry.registerTarget('persist-order-target', (u) => ({
  uri: u.raw,
  async open() {},
  async write(_ex: Exchange<unknown>) {},
  async close() {},
}))

const pipeline: Pipeline = {
  id: 'p-persist-order',
  retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
  onError: 'fail-run',
  steps: [
    { type: 'source', config: { uri: 'persist-order-source://in' } },
    { type: 'target', config: { uri: 'persist-order-target://out' } },
  ],
}

function ctx(root: string): GlobalContext {
  return {
    project: { name: 't', root },
    defaults: {
      retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
      onError: 'fail-run',
      concurrency: 1,
    },
    settings: {},
    env: {},
  }
}

describe('runner state persist order', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mt-state-order-'))
    writes.completed.length = 0
  })

  it('keeps the terminal done state on disk when a mid-run snapshot is still in flight', async () => {
    const run = await new Runner(pipeline, ctx(root)).start()

    // The race needs a mid-run snapshot: the initial `running` write plus the
    // one scheduled after the target step.
    expect(writes.completed.filter((s) => s === 'running').length).toBeGreaterThanOrEqual(2)

    const state = JSON.parse(
      await readFile(join(root, '.mt', 'runs', run.runId, 'state.json'), 'utf8'),
    ) as { state: string }

    expect(state.state).toBe('done')
    expect(writes.completed.at(-1)).toBe('done')
  })
})
