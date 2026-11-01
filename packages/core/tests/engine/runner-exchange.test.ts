import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { GlobalContext } from '../../src/contexts.js'
import { Runner } from '../../src/engine/runner.js'
import {
  BATCH_MEMBERS_VARIABLE,
  type Exchange,
  ITEM_VARIABLE,
  createExchange,
  getVariable,
  itemsOf,
  oldItemOf,
  setVariable,
  unbatchExchange,
  withBatchMembers,
  withItem,
  withMeta,
} from '../../src/exchange.js'
import type { Pipeline, Splitter, Tool } from '../../src/types.js'
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

  it('split passes the full envelope and fans out children like flatMap', async () => {
    const member = createExchange('member', { id: 'member' })
    const parent = setVariable(
      withBatchMembers(
        createExchange(['member'], {
          id: 'parent',
          items: ['member'],
          meta: { chapterId: 'c' },
        }),
        [member],
      ),
      'k',
      'v',
    )
    inputs.push(parent)

    let seen: Exchange<unknown> | undefined
    const splitter: Splitter<string> = {
      name: 'inspect',
      split(env) {
        seen = env
        return ['a', 'b']
      },
    }
    await new Runner(pipe([{ type: 'split', config: { splitter } }]), ctx(root)).start()

    expect(seen?.item).toEqual(['member'])
    expect(seen?.meta).toEqual({ chapterId: 'c' })
    expect(seen?.variables.some((v) => v.name === BATCH_MEMBERS_VARIABLE)).toBe(true)
    expect(outputs).toHaveLength(2)
    expect(outputs.map((o) => o.id)).toEqual(['parent.0', 'parent.1'])
    expect(outputs.map((o) => o.meta)).toEqual([
      { chapterId: 'c', parentId: 'parent' },
      { chapterId: 'c', parentId: 'parent' },
    ])
    expect(outputs.map((o) => getVariable(o, 'k'))).toEqual(['v', 'v'])
    expect(outputs.some((o) => o.variables.some((v) => v.name === BATCH_MEMBERS_VARIABLE))).toBe(
      false,
    )
    for (const output of outputs) {
      expect(output.variables.filter((v) => v.name === ITEM_VARIABLE)).toHaveLength(1)
    }
  })

  it('unbatchExchange (internal) falls back to items[] when a group carries no members', () => {
    const loose = createExchange([10, 20], { items: [10, 20], meta: { chapterNum: 9 } })
    const members = unbatchExchange(loose)
    expect(members.map((m) => m.item)).toEqual([10, 20])
    expect(members.map((m) => m.meta)).toEqual([
      { chapterNum: 9, parentId: loose.id, batchIndex: 0 },
      { chapterNum: 9, parentId: loose.id, batchIndex: 1 },
    ])
    expect(members[0]?.id).toBe(`${loose.id}.0`)
  })

  it('item variable stays in sync through tool, batch and flatMap', async () => {
    inputs.push({ item: 2 }, { item: 3 })
    await new Runner(
      pipe([{ type: 'tool', config: { name: 'tag', tool: tag } }]),
      ctx(root),
    ).start()
    for (const o of outputs) {
      expect(getVariable(o, ITEM_VARIABLE)).toBe(o.item)
    }
    expect(outputs.map((o) => oldItemOf(o))).toEqual([2, 3])

    outputs.length = 0
    await new Runner(pipe([{ type: 'batch', config: { size: 2 } }]), ctx(root)).start()
    expect(outputs[0]?.item).toEqual([2, 3])
    expect(getVariable(outputs[0] as Exchange, ITEM_VARIABLE)).toEqual([2, 3])
    expect(itemsOf(outputs[0] as Exchange)).toEqual([2, 3])

    outputs.length = 0
    await new Runner(
      pipe([{ type: 'flatmap', config: { fn: async (n: unknown) => [`${n}a`, `${n}b`] } }]),
      ctx(root),
    ).start()
    expect(outputs.map((o) => [o.item, getVariable(o, ITEM_VARIABLE)])).toEqual([
      ['2a', '2a'],
      ['2b', '2b'],
      ['3a', '3a'],
      ['3b', '3b'],
    ])
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
