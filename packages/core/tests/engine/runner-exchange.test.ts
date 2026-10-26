import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import {
  type Exchange,
  createExchange,
  getVariable,
  setVariable,
  withItem,
} from '../../src/exchange.js'
import type { Pipeline, Tool } from '../../src/types.js'
import { registry } from '../../src/uri.js'

const inputs: Array<Exchange<unknown> | { item: unknown }> = []
const outputs: Array<Exchange<unknown>> = []

registry.registerSource('runner-ex-source', (u) => ({
  uri: u.raw,
  lifestyle: 'resumable' as const,
  async *start() {
    for (const e of inputs) yield e
  },
  async *resume() {
    for (const e of inputs) yield e
  },
}))
registry.registerTarget('runner-ex-target', (u) => ({
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

const tag: Tool<number, number> = {
  name: 'tag',
  version: '1',
  mdDescription: 'sets variable',
  async invoke(ex) {
    return setVariable(withItem(ex, ex.item * 2), 'seen', ex.item)
  },
}

function pipe(steps: Pipeline['steps']): Pipeline {
  return {
    id: 'p-ex',
    retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
    onError: 'fail-run',
    steps: [
      { type: 'source', config: { uri: 'runner-ex-source://in' } },
      ...steps,
      { type: 'target', config: { uri: 'runner-ex-target://out' } },
    ],
  }
}

describe('runner exchange semantics', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mt-ex-'))
    inputs.length = 0
    outputs.length = 0
  })

  it('normalizes loose source items and propagates id/variables through a tool', async () => {
    inputs.push({ item: 2 }, createExchange(3, { id: 'fixed', meta: { chapterId: 'c' } }))
    await new Runner(
      pipe([{ type: 'tool', config: { name: 'tag', tool: tag } }]),
      ctx(root),
    ).start()
    expect(outputs.map((o) => o.item)).toEqual([4, 6])
    expect(outputs[0]?.id).toMatch(/^ex-/)
    expect(outputs[1]?.id).toBe('fixed')
    expect(outputs[1]?.meta).toEqual({ chapterId: 'c' })
    expect(getVariable(outputs[1] as Exchange, 'seen')).toBe(3)
  })

  it('batch merges variables; flatMap children inherit variables with parent link', async () => {
    inputs.push(
      setVariable(createExchange(1, { id: 'a' }), 'k', 'first'),
      setVariable(createExchange(2, { id: 'b' }), 'k', 'second'),
    )
    await new Runner(pipe([{ type: 'batch', config: { size: 2 } }]), ctx(root)).start()
    expect(outputs).toHaveLength(1)
    expect(outputs[0]?.items).toEqual([1, 2])
    expect(getVariable(outputs[0] as Exchange, 'k')).toBe('second')

    outputs.length = 0
    const fm = async (n: unknown) => [n, n]
    await new Runner(pipe([{ type: 'flatmap', config: { fn: fm } }]), ctx(root)).start()
    expect(outputs).toHaveLength(4)
    expect(outputs[0]?.id).toBe('a.0')
    expect(outputs[1]?.id).toBe('a.1')
    expect(outputs[0]?.meta.parentId).toBe('a')
    expect(getVariable(outputs[2] as Exchange, 'k')).toBe('second')
  })

  it('cache key ignores ephemeral variables', async () => {
    let calls = 0
    const cached: Tool<number, number> = {
      name: 'c',
      version: '1',
      mdDescription: 'c',
      cacheable: true,
      async invoke(ex) {
        calls++
        return ex
      },
    }
    const mk = (tmp: string) =>
      setVariable(createExchange(1, { id: 'z' }), 'tmp', tmp, { ephemeral: true })
    inputs.push(mk('a'), mk('b'))
    await new Runner(
      pipe([{ type: 'tool', config: { name: 'c', tool: cached } }]),
      ctx(root),
    ).start()
    expect(calls).toBe(1)
  })
})
