import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import type { LlmMessage } from '../src/core/llm-client.js'
import {
  type ShrinkStrategy,
  contextWindow,
  createContextWindow,
  dropMiddle,
  dropOldest,
  fitMessages,
  resolveContextConfig,
  slidingWindow,
  summarize,
  truncateHead,
  truncateLines,
  truncateTail,
} from '../src/core/llm-context.js'
import { mockLlmClient } from '../src/core/llm-gate.js'

/** 1 token per 4 chars; deterministic. */
const countTokens = (t: string) => Math.ceil(t.length / 4)
const ctx = {} as ToolContext
const msg = (role: LlmMessage['role'], n: number, ch = 'x'): LlmMessage => ({
  role,
  content: ch.repeat(n),
})
// per-message overhead is 4 tokens
const convo = (): LlmMessage[] => [
  msg('system', 40, 's'), // 10+4
  msg('user', 40, 'a'), // 14
  msg('assistant', 40, 'b'), // 14
  msg('user', 40, 'c'), // 14
  msg('assistant', 40, 'd'), // 14
  msg('user', 40, 'e'), // 14 (last user)
]

const run = (
  m: LlmMessage[],
  limit: number | null,
  strategies: Parameters<typeof fitMessages>[1],
) => fitMessages(m, { limit, countTokens, ...strategies })

describe('budget edge cases', () => {
  it('no budget -> untouched, nothing measured', async () => {
    const r = await run(convo(), null, { strategies: ['dropOldest'] })
    expect(r.messages).toHaveLength(6)
    expect(r.record.budget).toBeNull()
    expect(r.record.applied).toEqual([])
  })
  it('already fits -> no strategy applied', async () => {
    const r = await run(convo(), 1000, { strategies: ['dropOldest'] })
    expect(r.record.applied).toEqual([])
    expect(r.record.fits).toBe(true)
    expect(r.record.before).toBe(r.record.after)
  })
  it('exact fit boundary', async () => {
    const r = await run(convo(), 84, { strategies: ['dropOldest'] })
    expect(r.messages).toHaveLength(6)
  })
  it('impossible budget keeps system + last user and reports fits=false', async () => {
    const r = await run(convo(), 5, { strategies: ['dropOldest', 'truncateLines'] })
    expect(r.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(r.messages[1]?.content).toBe('e'.repeat(40))
    expect(r.record.fits).toBe(false)
  })
  it('empty messages', async () => {
    const r = await run([], 10, { strategies: ['dropOldest'] })
    expect(r.messages).toEqual([])
  })
  it('onOverflow=throw via tool', async () => {
    const tool = createContextWindow({
      maxTokens: 5,
      countTokens,
      strategies: ['dropOldest'],
      onOverflow: 'throw',
    })
    await expect(tool.invoke({ item: convo(), meta: {} }, ctx)).rejects.toThrow(/still exceed/)
  })
})

describe('strategies', () => {
  it('dropOldest drops oldest unprotected first', async () => {
    const r = await run(convo(), 56, { strategies: [dropOldest()] })
    expect(r.messages.map((m) => m.content[0])).toEqual(['s', 'c', 'd', 'e'])
  })
  it('dropOldest keepLast keeps recent turns', async () => {
    const r = await run(convo(), 30, { strategies: [dropOldest({ keepLast: 2 })] })
    expect(r.messages.map((m) => m.content[0])).toEqual(['s', 'd', 'e'])
    expect(r.record.fits).toBe(false)
  })
  it('dropMiddle keeps head and tail', async () => {
    const r = await run(convo(), 56, { strategies: [dropMiddle({ keepHead: 1, keepTail: 2 })] })
    const first = r.messages.map((m) => m.content[0])
    expect(first).toContain('s')
    expect(first).toContain('a')
    expect(first).toContain('d')
    expect(first).toContain('e')
    expect(first).not.toContain('b')
  })
  it('slidingWindow keeps last N + protected', async () => {
    const r = await run(convo(), 1000, { strategies: [slidingWindow({ size: 2 })] })
    // fits already -> untouched
    expect(r.messages).toHaveLength(6)
    const r2 = await run(convo(), 60, { strategies: [slidingWindow({ size: 2 })] })
    expect(r2.messages.map((m) => m.content[0])).toEqual(['s', 'c', 'd', 'e'])
    const r3 = await run(convo(), 45, { strategies: [slidingWindow({ size: 2 })] })
    expect(r3.messages.map((m) => m.content[0])).toEqual(['s', 'd', 'e'])
  })
  it('slidingWindow shrinks window below size when needed', async () => {
    const r = await run(convo(), 28, { strategies: [slidingWindow({ size: 4 })] })
    expect(r.messages.map((m) => m.content[0])).toEqual(['s', 'e'])
  })

  const big = (): LlmMessage[] => [
    msg('system', 20, 's'),
    { role: 'user', content: Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n') },
    msg('user', 8, 'q'),
  ]
  it('truncateTail keeps head of the largest message', async () => {
    const r = await run(big(), 60, { strategies: [truncateTail({ minChars: 20 })] })
    expect(r.record.fits).toBe(true)
    expect(r.messages[1]?.content.startsWith('line0')).toBe(true)
    expect(r.messages[1]?.content).toContain('[...truncated...]')
    expect(r.messages[2]?.content).toBe('q'.repeat(8))
  })
  it('truncateHead keeps tail', async () => {
    const r = await run(big(), 60, { strategies: [truncateHead({ minChars: 20 })] })
    expect(r.record.fits).toBe(true)
    expect(r.messages[1]?.content.endsWith('line39')).toBe(true)
  })
  it('truncateLines removes middle lines, keeps first and last', async () => {
    const r = await run(big(), 60, { strategies: [truncateLines({ minChars: 20 })] })
    expect(r.record.fits).toBe(true)
    const c = r.messages[1]?.content ?? ''
    expect(c.startsWith('line0\n')).toBe(true)
    expect(c.endsWith('line39')).toBe(true)
    expect(c).toContain('[...truncated...]')
  })
  it('truncate never touches protected last user message', async () => {
    const m = [msg('system', 8), msg('user', 4000, 'u')]
    const r = await run(m, 10, { strategies: ['truncateTail'] })
    expect(r.messages[1]?.content).toHaveLength(4000)
    expect(r.record.fits).toBe(false)
  })
})

describe('summarize', () => {
  it('replaces oldest chunk with ONE summary message using a customizable prompt', async () => {
    const llm = mockLlmClient(['SHORT SUMMARY'])
    const r = await fitMessages(convo(), {
      limit: 60,
      countTokens,
      llm,
      model: 'm',
      strategies: [summarize({ keepLast: 1 })],
      prompt: (name, vars) => `CUSTOM[${name}] ${vars.transcript}`,
    })
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]?.messages[0]?.content).toMatch(/^CUSTOM\[context.summarize\] user: a+/)
    const contents = r.messages.map((m) => m.content)
    expect(contents.filter((c) => c.includes('SHORT SUMMARY'))).toHaveLength(1)
    expect(r.messages[0]?.role).toBe('system')
    expect(r.messages.at(-1)?.content).toBe('e'.repeat(40))
    expect(r.record.fits).toBe(true)
  })
  it('falls back to dropOldest on failure and says so', async () => {
    const llm = mockLlmClient([new Error('boom')])
    const r = await fitMessages(convo(), {
      limit: 40,
      countTokens,
      llm,
      model: 'm',
      strategies: [summarize({ keepLast: 1 })],
    })
    expect(r.record.fits).toBe(true)
    expect(r.record.applied[0]?.note).toMatch(/fallback:boom/)
  })
  it('falls back without a client', async () => {
    const r = await fitMessages(convo(), {
      limit: 40,
      countTokens,
      strategies: [['summarize', { keepLast: 1 }]],
    })
    expect(r.record.applied[0]?.note).toMatch(/fallback:no-llm/)
  })
})

describe('composition', () => {
  it('applies ordered strategies until it fits and records each', async () => {
    const r = await run(convo(), 56, { strategies: ['truncateLines', 'dropOldest'] })
    expect(r.record.applied.map((a) => a.name)).toEqual(['truncateLines', 'dropOldest'])
    expect(r.record.fits).toBe(true)
  })
  it('stops once it fits (later strategies skipped)', async () => {
    const r = await run(convo(), 70, { strategies: ['dropOldest', 'truncateLines'] })
    expect(r.record.applied.map((a) => a.name)).toEqual(['dropOldest'])
  })
  it('accepts [name, options] tuples and custom strategy objects', async () => {
    const custom: ShrinkStrategy = {
      name: 'keepOnlyLastTwo',
      apply: (m) => m.slice(-2),
    }
    const r = await run(convo(), 20, { strategies: [['dropOldest', { keepLast: 1 }], custom] })
    expect(r.record.applied.map((a) => a.name)).toEqual(['dropOldest', 'keepOnlyLastTwo'])
  })
  it('unknown strategy name fails clearly', async () => {
    await expect(run(convo(), 10, { strategies: ['nope'] })).rejects.toThrow(
      /Unknown context strategy/,
    )
  })
  it('system and last user can be unprotected', async () => {
    const r = await run(convo(), 14, {
      strategies: ['dropOldest'],
      preserveSystem: false,
      preserveLastUser: false,
    })
    expect(r.messages).toHaveLength(1)
  })
})

describe('resolveContextConfig precedence', () => {
  it('input > options > meta > settings > env', () => {
    const args = {
      input: { maxTokens: 1 },
      options: { maxTokens: 2 },
      meta: { context: { maxTokens: 3 } },
      settings: { 'context.maxTokens': 4 },
      env: { MT_CONTEXT_MAX_TOKENS: '5' },
    }
    expect(resolveContextConfig(args).limit).toBe(1)
    expect(resolveContextConfig({ ...args, input: undefined }).limit).toBe(2)
    expect(resolveContextConfig({ ...args, input: undefined, options: undefined }).limit).toBe(3)
    expect(resolveContextConfig({ settings: args.settings, env: args.env }).limit).toBe(4)
    expect(resolveContextConfig({ env: args.env }).limit).toBe(5)
    expect(resolveContextConfig({}).limit).toBeNull()
  })
  it('limit = min(maxTokens, contextLimit - reserve)', () => {
    expect(resolveContextConfig({ options: { contextLimit: 1000, reserve: 200 } }).limit).toBe(800)
    expect(
      resolveContextConfig({ options: { maxTokens: 500, contextLimit: 1000, reserve: 200 } }).limit,
    ).toBe(500)
    expect(resolveContextConfig({ options: { contextLimit: 100, reserve: 500 } }).limit).toBe(0)
  })
  it('strategies from env list and settings', () => {
    expect(
      resolveContextConfig({ env: { MT_CONTEXT_STRATEGIES: 'truncateLines, dropOldest' } })
        .strategies,
    ).toEqual(['truncateLines', 'dropOldest'])
    expect(resolveContextConfig({}).strategies).toEqual(['dropOldest', 'truncateLines'])
  })
})

describe('contextWindow tool', () => {
  it('shrinks messages item, keeps shape, records meta.contextWindow', async () => {
    const tool = createContextWindow({ maxTokens: 56, countTokens, strategies: ['dropOldest'] })
    const out = await tool.invoke({ item: { messages: convo(), model: 'x' }, meta: { k: 1 } }, ctx)
    const item = out.item as { messages: LlmMessage[]; model: string }
    expect(item.model).toBe('x')
    expect(item.messages).toHaveLength(4)
    expect(out.meta.k).toBe(1)
    const rec = out.meta.contextWindow as {
      before: number
      after: number
      budget: number
      applied: unknown[]
    }
    expect(rec).toMatchObject({ before: 84, after: 56, budget: 56 })
    expect(rec.applied).toHaveLength(1)
  })
  it('text item stays text and is truncated', async () => {
    const tool = createContextWindow({ maxTokens: 30, countTokens, strategies: ['truncateTail'] })
    const out = await tool.invoke({ item: 'y'.repeat(2000), meta: {} }, ctx)
    expect(typeof out.item).toBe('string')
    expect((out.item as string).length).toBeLessThan(2000)
  })
  it('budget from meta.context and per-item context', async () => {
    const tool = createContextWindow({ countTokens, strategies: ['dropOldest'] })
    const a = await tool.invoke({ item: convo(), meta: { context: { maxTokens: 56 } } }, ctx)
    expect((a.item as LlmMessage[]).length).toBe(4)
    const b = await tool.invoke(
      { item: { messages: convo(), context: { maxTokens: 28 } }, meta: {} },
      ctx,
    )
    expect((b.item as { messages: LlmMessage[] }).messages).toHaveLength(2)
  })
  it('default instance without budget is a no-op', async () => {
    const out = await contextWindow.invoke({ item: convo(), meta: {} }, ctx)
    expect(out.item).toHaveLength(6)
  })
  it('batch items', async () => {
    const tool = createContextWindow({ maxTokens: 56, countTokens, strategies: ['dropOldest'] })
    const out = await tool.invoke({ item: convo(), items: [convo(), convo()], meta: {} }, ctx)
    expect(out.items).toHaveLength(2)
    expect(Array.isArray(out.meta.contextWindow)).toBe(true)
  })
})
