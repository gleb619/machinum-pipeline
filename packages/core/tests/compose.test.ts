import { describe, expect, it } from 'vitest'
import type { ToolContext } from '../src/contexts.js'
import { chain, defineComposableTool, definePipeline, defineTool } from '../src/dsl.js'

const ctx = {} as ToolContext
const appender = (name: string) =>
  defineTool<unknown, unknown>({
    name,
    version: '1',
    mdDescription: name,
    invoke: async (env) => ({
      ...env,
      meta: { ...env.meta, trail: [...((env.meta.trail as string[]) ?? []), name] },
    }),
  })

describe('chain', () => {
  it('runs tools in order', async () => {
    const t = chain('abc', appender('a'), appender('b'), appender('c'))
    const out = await t.invoke({ item: 1, meta: {} }, ctx)
    expect(out.meta.trail).toEqual(['a', 'b', 'c'])
    expect(t.name).toBe('abc')
  })

  it('useAll adds one tool step per tool', () => {
    const p = definePipeline({ id: 'x' }).useAll(appender('a'), appender('b'))
    expect(p.steps.map((s) => s.config.name)).toEqual(['a', 'b'])
  })
})

describe('defineComposableTool', () => {
  const make = () =>
    defineComposableTool<unknown, unknown, 'build' | 'emit'>({
      name: 'ct',
      version: '1',
      mdDescription: 'ct',
      slots: { build: appender('build'), emit: appender('emit') },
    })

  it('runs slots in declaration order', async () => {
    const out = await make().invoke({ item: 1, meta: {} }, ctx)
    expect(out.meta.trail).toEqual(['build', 'emit'])
  })

  it('with() swaps a slot without mutating the original', async () => {
    const base = make()
    const swapped = base.with({ emit: appender('mock') })
    expect((await swapped.invoke({ item: 1, meta: {} }, ctx)).meta.trail).toEqual(['build', 'mock'])
    expect((await base.invoke({ item: 1, meta: {} }, ctx)).meta.trail).toEqual(['build', 'emit'])
    expect(swapped).not.toBe(base)
    expect(base.slots.emit.name).toBe('emit')
  })

  it('with() accepts plain functions and rejects unknown slots', async () => {
    const t = make().with({ emit: async (env) => ({ ...env, item: 'fn' }) })
    expect((await t.invoke({ item: 1, meta: {} }, ctx)).item).toBe('fn')
    expect(() => make().with({ nope: appender('x') } as never)).toThrow(/no slot/)
  })

  it('with() is chainable', async () => {
    const t = make()
      .with({ build: appender('b2') })
      .with({ emit: appender('e2') })
    expect((await t.invoke({ item: 1, meta: {} }, ctx)).meta.trail).toEqual(['b2', 'e2'])
  })
})
