import type { ToolContext } from '@mt/core'
import { describe, expect, it } from 'vitest'
import type { LlmMessage } from '../src/llm-client.js'
import {
  createContextWindow,
  fitMessages,
  modelContextLimit,
  parseContextLimits,
} from '../src/llm-context.js'
import { LlmContextLengthError } from '../src/llm-errors.js'
import { mockLlmClient } from '../src/llm-gate.js'

/** 1 token per 4 chars; deterministic. */
const countTokens = (t: string) => Math.ceil(t.length / 4)
const msg = (role: LlmMessage['role'], n: number, ch = 'x'): LlmMessage => ({
  role,
  content: ch.repeat(n),
})

const ctxWith = (global: Record<string, unknown>): ToolContext =>
  ({ run: { global: { settings: {}, env: {}, ...global } } }) as unknown as ToolContext
const ctx = {} as ToolContext

// ---------------------------------------------------------------------------
// modelContextLimit matching + overrides
// ---------------------------------------------------------------------------

describe('modelContextLimit', () => {
  it('matches built-in families, incl. provider-prefixed OpenRouter ids', () => {
    expect(modelContextLimit('openai/gpt-4o-mini')).toBe(128_000)
    expect(modelContextLimit('gpt-4.1-2025-04-14')).toBe(1_000_000)
    expect(modelContextLimit('anthropic/claude-sonnet-4-20250514')).toBe(200_000)
    expect(modelContextLimit('google/gemini-2.5-pro')).toBe(1_000_000)
    expect(modelContextLimit('meta-llama/llama-3.1-8b-instruct')).toBe(128_000)
    expect(modelContextLimit('deepseek/deepseek-chat')).toBe(65_536)
    expect(modelContextLimit('qwen/qwen2.5-72b-instruct')).toBe(128_000)
    expect(modelContextLimit('mistralai/mistral-large-2411')).toBe(128_000)
    expect(modelContextLimit('some-unknown-model')).toBeUndefined()
    expect(modelContextLimit(undefined)).toBeUndefined()
  })

  it('user limits override the built-in table (first match wins)', () => {
    const limits = { 'gpt-4o*': 999, 'my-model': 12_345 }
    expect(modelContextLimit('openai/gpt-4o-mini', limits)).toBe(999)
    expect(modelContextLimit('my-model', limits)).toBe(12_345)
    expect(modelContextLimit('claude-haiku-4-5', limits)).toBe(200_000)
  })

  it('parseContextLimits accepts JSON strings and objects, rejects garbage', () => {
    expect(parseContextLimits('{"a*": 100}')).toEqual({ 'a*': 100 })
    expect(parseContextLimits({ b: 42 })).toEqual({ b: 42 })
    expect(parseContextLimits('not json')).toBeUndefined()
    expect(parseContextLimits({ bad: 'x', neg: -1 })).toBeUndefined()
    expect(parseContextLimits(undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// autoLimit (default on when the model is known)
// ---------------------------------------------------------------------------

describe('autoLimit', () => {
  it('known model implies a budget by default', async () => {
    const tool = createContextWindow({ countTokens })
    const out = await tool.invoke(
      { item: { messages: [msg('user', 40)], model: 'openai/gpt-4o-mini' }, meta: {} },
      ctx,
    )
    expect(out.meta.contextWindow).toMatchObject({ budget: 128_000, fits: true })
  })

  it('user limits via env MT_CONTEXT_LIMITS win over the table', async () => {
    const tool = createContextWindow({ countTokens })
    const c = ctxWith({ env: { MT_CONTEXT_LIMITS: '{"gpt-4o*": 5000}' } })
    const out = await tool.invoke(
      { item: { messages: [msg('user', 40)], model: 'gpt-4o-mini' }, meta: {} },
      c,
    )
    expect(out.meta.contextWindow).toMatchObject({ budget: 5000 })
  })

  it('autoLimit: false (option / env / settings) turns it off', async () => {
    const tool = createContextWindow({ countTokens, autoLimit: false })
    const out = await tool.invoke(
      { item: { messages: [msg('user', 40)], model: 'gpt-4o-mini' }, meta: {} },
      ctx,
    )
    expect(out.meta.contextWindow).toMatchObject({ budget: null })

    const envTool = createContextWindow({ countTokens })
    const envOut = await envTool.invoke(
      { item: { messages: [msg('user', 40)], model: 'gpt-4o-mini' }, meta: {} },
      ctxWith({ env: { MT_CONTEXT_AUTO_LIMIT: '0' } }),
    )
    expect(envOut.meta.contextWindow).toMatchObject({ budget: null })

    const stOut = await envTool.invoke(
      { item: { messages: [msg('user', 40)], model: 'gpt-4o-mini' }, meta: {} },
      ctxWith({ settings: { 'context.autoLimit': false } }),
    )
    expect(stOut.meta.contextWindow).toMatchObject({ budget: null })
  })

  it('explicit contextLimit still wins over the model table', async () => {
    const tool = createContextWindow({ countTokens, contextLimit: 100 })
    const out = await tool.invoke(
      { item: { messages: [msg('user', 40)], model: 'gpt-4o-mini' }, meta: {} },
      ctx,
    )
    expect(out.meta.contextWindow).toMatchObject({ budget: 100 })
  })
})

// ---------------------------------------------------------------------------
// lastMessage strategies for an oversized final user message
// ---------------------------------------------------------------------------

describe('lastMessage strategies', () => {
  // system 10+4 tokens, one huge user message
  const oversize = (): LlmMessage[] => [msg('system', 40, 's'), msg('user', 4000, 'u')]

  it('off (default): last user stays untouched, fits=false', async () => {
    const r = await fitMessages(oversize(), {
      limit: 100,
      countTokens,
      strategies: ['dropOldest'],
    })
    expect(r.record.fits).toBe(false)
    expect(r.messages[1]?.content).toHaveLength(4000)
    expect(r.record.applied.map((a) => a.name)).not.toContain('truncateLastMessage')
  })

  it('truncate: keeps head and tail with an elision marker, fits=true', async () => {
    const r = await fitMessages(oversize(), {
      limit: 100,
      countTokens,
      strategies: ['dropOldest'],
      lastMessage: 'truncate',
    })
    expect(r.record.fits).toBe(true)
    const content = r.messages[1]?.content ?? ''
    expect(content).toContain('[...truncated...]')
    expect(content.startsWith('uuuu')).toBe(true)
    expect(content.trimEnd().endsWith('uuuu')).toBe(true)
    expect(r.record.applied.map((a) => a.name)).toContain('truncateLastMessage')
    expect(r.record.after).toBeLessThanOrEqual(100)
  })

  it('summarize: LLM summary replaces the message; falls back to truncate without a client', async () => {
    const llm = mockLlmClient(['short summary'])
    const r = await fitMessages(oversize(), {
      limit: 100,
      countTokens,
      strategies: ['dropOldest'],
      lastMessage: 'summarize',
      llm,
      model: 'm',
    })
    expect(r.record.fits).toBe(true)
    expect(r.messages[1]?.content).toContain('short summary')
    expect(r.record.applied.map((a) => a.name)).toContain('summarizeLastMessage')
    expect(llm.calls).toHaveLength(1)

    const fb = await fitMessages(oversize(), {
      limit: 100,
      countTokens,
      strategies: ['dropOldest'],
      lastMessage: 'summarize',
    })
    expect(fb.record.fits).toBe(true)
    expect(fb.messages[1]?.content).toContain('[...truncated...]')
    expect(fb.record.applied.map((a) => a.name)).toContain('truncateLastMessage')
  })

  it('error: throws LlmContextLengthError', async () => {
    await expect(
      fitMessages(oversize(), {
        limit: 100,
        countTokens,
        strategies: ['dropOldest'],
        lastMessage: 'error',
      }),
    ).rejects.toBeInstanceOf(LlmContextLengthError)
  })

  it('system message is never dropped, even at impossible budgets', async () => {
    const r = await fitMessages(oversize(), {
      limit: 5,
      countTokens,
      strategies: ['dropOldest'],
      lastMessage: 'truncate',
    })
    expect(r.messages[0]?.role).toBe('system')
    expect(r.record.fits).toBe(false)
  })

  it('config plumbing: env MT_CONTEXT_LAST_MESSAGE and settings context.lastMessage', async () => {
    const tool = createContextWindow({ countTokens, strategies: ['dropOldest'] })
    const withEnv = await tool.invoke(
      { item: { messages: oversize(), context: { maxTokens: 100 } }, meta: {} },
      ctxWith({ env: { MT_CONTEXT_LAST_MESSAGE: 'truncate' } }),
    )
    expect((withEnv.meta.contextWindow as { fits: boolean }).fits).toBe(true)

    // settings layer supplies lastMessage here, so the tool throws.
    await expect(
      tool.invoke(
        { item: { messages: oversize(), context: { maxTokens: 100 } }, meta: {} },
        ctxWith({ settings: { 'context.lastMessage': 'error' } }),
      ),
    ).rejects.toBeInstanceOf(LlmContextLengthError)
  })
})
