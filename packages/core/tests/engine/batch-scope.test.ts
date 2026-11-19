import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
import type {
  Exchange,
  GlobalContext,
  SourceContext,
  TargetContext,
  ToolContext,
} from '../../src/types.js'
import { registry } from '../../src/uri.js'

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

// Test stand-ins for the @mt/waypoint `batch://` views (core must not import waypoint); the URIs
// are the real `batch://group` / `batch://members` sources, so the DSL child-source rule accepts
// them while `@mt/waypoint` stays out of the core test run.
const view = (kind: 'group' | 'members'): Source<unknown> => ({
  uri: `batch://${kind}`,
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
  fn: (ex: Exchange<never>, ctx: ToolContext) => Exchange<unknown>,
): Tool<never, unknown> => ({
  name,
  version: '1',
  description: name,
  async invoke(ex, ctx) {
    return fn(ex, ctx)
  },
})

// `@mt/core` must not import the `batch://` waypoints, so the test registers stand-ins: the
// return target below and `bs-*` views for the explicit multi-stage form.
beforeAll(() => {
  registry.registerTarget('batch', () => ret)
})

function outer(nested: Pipeline, opts?: { size?: number; slide?: boolean }): Pipeline {
  const size = opts?.size ?? 2
  const uri = `batch://${opts?.slide ? 'slide' : ''}?size=${size}`
  return definePipeline({ id: 'outer' })
    .from(inSource)
    .subflow(uri, nested)
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
          // a non-per-member payload (a packet id) is never zipped back onto the members
          return setVariable(
            withItem(ex, `T${groupSizes.length}`),
            'packet',
            `packet-of-${groupSizes.length}`,
          )
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
      .subflow('batch://', nested)
      .to(outTarget) as Pipeline
    await new Runner(p, global(root)).start()
    expect(sizes).toEqual([5, 2])
    expect(outputs).toHaveLength(7)
  })

  it('a child without .from() receives the package as its input stream', async () => {
    inputs.push(...chapters(3))
    const seen: unknown[] = []
    const nested = definePipeline({ id: 'nested-input' })
      .use(
        tool('peek', (ex) => {
          seen.push(ex.item)
          return ex
        }),
      )
      .to(ret) as Pipeline

    await new Runner(outer(nested), global(root)).start()

    // size 2: package 1 = the first two payloads, package 2 = the remainder
    expect(seen).toEqual([['text-1', 'text-2'], ['text-3']])
    expect(outputs.map((o) => o.item)).toEqual(['text-1', 'text-2', 'text-3'])
  })

  it('a group payload array of the package length zips back onto the members by index', async () => {
    inputs.push(...chapters(2))
    const nested = definePipeline({ id: 'nested-zip' }).use(
      tool('zip', (ex) => withItem(ex, ['Z1', 'Z2'])),
    ) as Pipeline

    await new Runner(outer(nested), global(root)).start()

    expect(outputs.map((o) => o.item)).toEqual(['Z1', 'Z2'])
    expect(outputs.map((o) => o.id)).toEqual(['c1', 'c2'])
    expect(outputs.map((o) => o.meta)).toEqual([{ chapterNum: 1 }, { chapterNum: 2 }])
    expect(outputs.map((o) => getVariable(o, 'own'))).toEqual(['v1', 'v2'])
  })

  it('a payload array of another length is not zipped', async () => {
    inputs.push(...chapters(2))
    const nested = definePipeline({ id: 'nested-nozip' }).use(
      tool('one', (ex) => withItem(ex, ['only-one'])),
    ) as Pipeline

    await new Runner(outer(nested), global(root)).start()

    expect(outputs.map((o) => o.item)).toEqual(['text-1', 'text-2'])
  })

  it('an explicit member commit wins over the payload zip', async () => {
    inputs.push(...chapters(2))
    const nested = definePipeline({ id: 'nested-pin' }).use(
      tool('zip-then-pin', (ex, ctx) => {
        const zipped = withItem(ex, ['Z1', 'Z2'])
        ctx.run.batchScope?.commit(zipped)
        const first = ctx.run.batchScope?.members()[0]
        if (first) ctx.run.batchScope?.commit(withItem(first, 'EXPLICIT'))
        return zipped
      }),
    ) as Pipeline

    await new Runner(outer(nested), global(root)).start()

    expect(outputs.map((o) => o.item)).toEqual(['EXPLICIT', 'Z2'])
  })

  it('slide packages overlap and every package is patched', async () => {
    inputs.push(...chapters(3))
    const sizes: number[] = []
    const nested = definePipeline({ id: 'nested-slide' }).use(
      tool('count', (ex) => {
        const items = itemsOf(ex)
        sizes.push(items.length)
        return withItem(
          ex,
          items.map((item) => `${String(item)}+`),
        )
      }),
    ) as Pipeline

    await new Runner(outer(nested, { size: 2, slide: true }), global(root)).start()

    // size 2 over 3 items: [1, 2] then [2, 3] — the tail is not flushed when sliding
    expect(sizes).toEqual([2, 2])
    expect(outputs.map((o) => o.item)).toEqual(['text-1+', 'text-2+', 'text-2+', 'text-3+'])
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
