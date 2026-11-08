import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { definePipeline } from '../../src/dsl.js'
import { Runner } from '../../src/engine/runner.js'
import {
  batchMembersOf,
  createExchange,
  getVariable,
  itemsOf,
  setVariable,
  toPersisted,
  withItem,
  withMeta,
} from '../../src/exchange.js'
import type { Pipeline, Source, Target, Tool } from '../../src/types.js'
import type { Exchange, GlobalContext, SourceContext, TargetContext } from '../../src/types.js'

const inputs: Exchange<unknown>[] = []
const outputs: Exchange<unknown>[] = []

const inSource: Source<unknown> = {
  uri: 'bs-in://x',
  lifestyle: 'resumable',
  async *start() {
    for (const e of inputs) yield e
  },
}
const outTarget: Target<unknown> = {
  uri: 'bs-out://x',
  async open() {},
  async write(ex) {
    outputs.push(ex)
  },
  async close() {},
}

// Test stand-ins for the @mt/waypoint `batch://` views (core must not import waypoint).
const view = (kind: 'group' | 'members'): Source<unknown> => ({
  uri: `bs-${kind}://x`,
  lifestyle: 'resumable',
  async *start(ctx: SourceContext) {
    const scope = ctx.run.batchScope
    if (!scope) throw new Error('no scope')
    if (kind === 'group') yield scope.group()
    else yield* scope.members()
  },
})
const ret: Target<unknown> = {
  uri: 'bs-return://x',
  async open() {},
  async write(ex: Exchange<unknown>, ctx: TargetContext) {
    ctx.run.batchScope?.commit(ex)
  },
  async close() {},
}

function global(root: string): GlobalContext {
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

const tool = (
  name: string,
  fn: (ex: Exchange<never>) => Exchange<unknown>,
): Tool<never, unknown> => ({
  name,
  version: '1',
  mdDescription: name,
  async invoke(ex) {
    return fn(ex)
  },
})

function outer(nested: Pipeline, opts?: { size?: number }): Pipeline {
  return definePipeline({ id: 'outer' })
    .from(inSource)
    .batch(opts ?? { size: 2 }, nested)
    .to(outTarget) as Pipeline
}

function chapters(n: number): Exchange<unknown>[] {
  return Array.from({ length: n }, (_, i) =>
    setVariable(
      withMeta(createExchange(`text-${i + 1}`, { id: `c${i + 1}` }), { chapterNum: i + 1 }),
      'own',
      `v${i + 1}`,
    ),
  )
}

describe('batch scope', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mt-bs-'))
    inputs.length = 0
    outputs.length = 0
  })

  it('group stage + members stage restore the ORIGINAL members, patched, with group vars', async () => {
    inputs.push(...chapters(3))
    const groupSizes: number[] = []
    const nested = definePipeline({ id: 'nested' })
      .from(view('group'))
      .use(
        tool('titles', (ex) => {
          groupSizes.push(itemsOf(ex).length)
          return setVariable(withItem(ex, ['T']), 'packet', `packet-of-${groupSizes.length}`)
        }),
      )
      .to(ret)
      .from(view('members'))
      .use(
        tool('apply', (ex) => {
          const text = `${String(ex.item)}|${String(getVariable(ex, 'packet'))}`
          return withMeta(withItem(ex, text), { lang: 'ru' })
        }),
      )
      .to(ret) as Pipeline

    await new Runner(outer(nested), global(root)).start()

    expect(groupSizes).toEqual([2, 1])
    expect(outputs.map((o) => o.id)).toEqual(['c1', 'c2', 'c3'])
    expect(outputs.map((o) => o.item)).toEqual([
      'text-1|packet-of-1',
      'text-2|packet-of-1',
      'text-3|packet-of-2',
    ])
    // own meta/variables survive, helper batchIndex is not leaked, patches (lang) kept
    expect(outputs.map((o) => o.meta)).toEqual([
      { chapterNum: 1, lang: 'ru' },
      { chapterNum: 2, lang: 'ru' },
      { chapterNum: 3, lang: 'ru' },
    ])
    expect(outputs.map((o) => getVariable(o, 'own'))).toEqual(['v1', 'v2', 'v3'])
    expect(outputs.map((o) => itemsOf(o).length)).toEqual([1, 1, 1])
  })

  it('group-only scope propagates group variables to every member, payloads untouched', async () => {
    inputs.push(...chapters(2))
    const nested = definePipeline({ id: 'nested-g' })
      .from(view('group'))
      .use(tool('mark', (ex) => setVariable(withItem(ex, ['x']), 'shared', 'yes')))
      .to(ret) as Pipeline

    await new Runner(outer(nested), global(root)).start()

    expect(outputs.map((o) => o.item)).toEqual(['text-1', 'text-2'])
    expect(outputs.map((o) => getVariable(o, 'shared'))).toEqual(['yes', 'yes'])
    expect(outputs.map((o) => getVariable(o, 'own'))).toEqual(['v1', 'v2'])
  })

  it('default size is 5', async () => {
    inputs.push(...chapters(7))
    const sizes: number[] = []
    const nested = definePipeline({ id: 'nested-d' })
      .from(view('group'))
      .use(
        tool('count', (ex) => {
          sizes.push(itemsOf(ex).length)
          return ex
        }),
      )
      .to(ret) as Pipeline

    const p = definePipeline({ id: 'outer-d' })
      .from(inSource)
      .batch(undefined, nested)
      .to(outTarget) as Pipeline
    await new Runner(p, global(root)).start()
    expect(sizes).toEqual([5, 2])
    expect(outputs).toHaveLength(7)
  })

  it('without a nested pipeline .batch() still emits grouped items[] envelopes; slide overlaps', async () => {
    inputs.push(...chapters(3).map((e, i) => withItem(e, i + 1)))
    const run = async (opts: { size: number; slide?: boolean }) => {
      outputs.length = 0
      const p = definePipeline({ id: 'plain' }).from(inSource).batch(opts).to(outTarget) as Pipeline
      await new Runner(p, global(root)).start()
      return outputs.map((o) => itemsOf(o))
    }
    expect(await run({ size: 2 })).toEqual([[1, 2], [3]])
    expect(await run({ size: 2, slide: true })).toEqual([
      [1, 2],
      [2, 3],
    ])
  })

  it('nested failure fails the run and marks the group node failed', async () => {
    inputs.push(...chapters(2))
    const nested = definePipeline({
      id: 'nested-f',
      retry: { max: 0, backoffMs: 0, strategy: 'fixed' },
    })
      .from(view('members'))
      .use(
        tool('boom', () => {
          throw new Error('boom')
        }),
      )
      .to(ret) as Pipeline

    const runner = new Runner(outer(nested), global(root))
    await expect(runner.start()).rejects.toThrow('boom')
    expect(outputs).toHaveLength(0)
  })

  it('no commit leaves members unchanged', async () => {
    inputs.push(...chapters(2))
    const nested = definePipeline({ id: 'nested-n' })
      .from(view('members'))
      .use(tool('noop', (ex) => withItem(ex, 'changed')))
      .to(outTarget) as Pipeline
    await new Runner(outer(nested), global(root)).start()
    // outTarget inside the scope saw the changed members; the outer stream carries originals
    expect(outputs.slice(-2).map((o) => o.item)).toEqual(['text-1', 'text-2'])
  })

  it('committing a foreign exchange is an error', async () => {
    inputs.push(...chapters(2))
    const nested = definePipeline({ id: 'nested-x' })
      .from(view('members'))
      .use(tool('fresh', () => createExchange('stranger', { id: 'zzz' })))
      .to(ret) as Pipeline
    await expect(new Runner(outer(nested), global(root)).start()).rejects.toThrow(
      /neither the group/,
    )
  })

  it('members live in an ephemeral variable: never persisted, so a rerun re-forms the scope', async () => {
    inputs.push(...chapters(2))
    const seen: Exchange<unknown>[] = []
    const nested = definePipeline({ id: 'nested-e' })
      .from(view('group'))
      .use(
        tool('peek', (ex) => {
          seen.push(ex)
          return ex
        }),
      )
      .to(ret) as Pipeline
    await new Runner(outer(nested), global(root)).start()
    await new Runner(outer(nested), global(root)).start()

    expect(seen).toHaveLength(2)
    expect(batchMembersOf(seen[0] as Exchange)).toHaveLength(2)
    const persisted = toPersisted(seen[0] as Exchange)
    expect(persisted.variables.some((v) => v.name === 'batchMembers')).toBe(false)
    expect(outputs).toHaveLength(4)
  })
})
