import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { writeDeadLetter } from '../../src/engine/dead-letter.js'
import { Runner } from '../../src/engine/runner.js'
import {
  type Exchange,
  createExchange,
  fromPersisted,
  getVariable,
  setVariable,
  toPersisted,
  variable,
} from '../../src/exchange.js'
import { Store } from '../../src/store.js'
import type { Pipeline, Tool } from '../../src/types.js'
import { registry } from '../../src/uri.js'

/** Persistence contract: `meta` is in-flight only, `variables` persist (ephemeral dropped). */

const META_MARK = 'META-MARKER-XYZ'
const outputs: Exchange<unknown>[] = []
let failOn: number | null = null

function seed(n: number): Exchange<number> {
  let ex = createExchange(n, { id: `e${n}`, meta: { chapterId: META_MARK } })
  ex = setVariable(ex, 'chapterId', `ch-${n}`)
  ex = setVariable(ex, 'scratch', 'tmp', { ephemeral: true })
  return ex
}

registry.registerSource('persist-source', (u) => ({
  uri: u.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const n of [1, 2, 3]) yield seed(n)
  },
  async *resume() {
    for (const n of [1, 2, 3]) yield seed(n)
  },
}))
registry.registerTarget('persist-target', (u) => ({
  uri: u.raw,
  async open() {},
  async write(ex: Exchange<unknown>) {
    outputs.push(ex)
  },
  async close() {},
}))

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

const flaky: Tool<number, number> = {
  name: 'flaky',
  version: '1',
  mdDescription: 'fails on one item',
  async invoke(ex) {
    if (ex.item === failOn) throw new Error('boom')
    return ex
  },
}

function pipe(onError: 'fail-run' | 'dead-letter'): Pipeline {
  return {
    id: 'p-persist',
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
    onError,
    steps: [
      { type: 'source', config: { uri: 'persist-source://in' } },
      { type: 'tool', config: { name: 'flaky', tool: flaky } },
      { type: 'target', config: { uri: 'persist-target://out' } },
    ],
  }
}

async function readAll(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) {
      const p = join(e.parentPath, e.name)
      out[p] = await readFile(p, 'utf8')
    }
  }
  return out
}

describe('persistence contract', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mt-persist-'))
    outputs.length = 0
    failOn = null
  })

  it('toPersisted/fromPersisted: variables keep qualifier+timestamp, meta and ephemeral dropped', () => {
    const ts = '2024-01-02T03:04:05.000Z'
    let ex = createExchange('x', { id: 'a', meta: { chapterId: 'c' } })
    ex = { ...ex, variables: [variable('k', 1, { id: 'v1', qualifier: 'old', timestamp: ts })] }
    ex = setVariable(ex, 'tmp', 2, { ephemeral: true })
    const back = fromPersisted(JSON.parse(JSON.stringify(toPersisted(ex))))
    expect(back.meta).toEqual({})
    expect(back.id).toBe('a')
    expect(back.variables).toEqual([
      { id: 'v1', name: 'k', qualifier: 'old', value: 1, timestamp: ts, ephemeral: false },
    ])
  })

  it('dead-letter entry (real Store) round-trips variables, drops meta and ephemeral', async () => {
    const store = new Store(root)
    const src = seed(1)
    await writeDeadLetter(store, 'r1', src, new Error('x'), 's1')
    const line = (await readFile(join(root, 'runs', 'r1', 'dead-letter.jsonl'), 'utf8')).trim()
    const entry = JSON.parse(line) as { envelope: Record<string, unknown> }
    expect(entry.envelope.meta).toBeUndefined()
    expect(line).not.toContain(META_MARK)
    const back = fromPersisted(entry.envelope as never)
    expect(getVariable(back, 'chapterId')).toBe('ch-1')
    expect(getVariable(back, 'scratch')).toBeUndefined()
    const orig = src.variables.find((v) => v.name === 'chapterId')
    expect(back.variables[0]?.timestamp).toBe(orig?.timestamp)
    expect(back.variables[0]?.qualifier).toBe('new')
  })

  it('runner dead-letter policy persists variables, never meta', async () => {
    failOn = 2
    const run = await new Runner(pipe('dead-letter'), ctx(root)).start()
    const files = await readAll(join(root, '.mt', 'runs', run.runId))
    const dl = Object.entries(files).find(([p]) => p.endsWith('dead-letter.jsonl'))?.[1] ?? ''
    expect(dl).toContain('ch-2')
    expect(dl).not.toContain(META_MARK)
    expect(dl).not.toContain('"scratch"')
  })

  it('checkpoint/state/events hold no exchange payload; resume re-derives meta from the Source', async () => {
    failOn = 2
    const first = new Runner(pipe('fail-run'), ctx(root))
    await expect(first.start()).rejects.toThrow('boom')
    const runId = (await readdir(join(root, '.mt', 'runs')))[0] as string
    const files = await readAll(join(root, '.mt', 'runs', runId))
    for (const content of Object.values(files)) {
      expect(content).not.toContain(META_MARK)
      expect(content).not.toContain('ch-2')
    }
    failOn = null
    outputs.length = 0
    await new Runner(pipe('fail-run'), ctx(root)).resume(runId)
    expect(outputs.length).toBeGreaterThan(0)
    for (const o of outputs) {
      expect(o.meta.chapterId).toBe(META_MARK)
      expect(getVariable(o, 'chapterId')).toMatch(/^ch-/)
    }
  })
})
