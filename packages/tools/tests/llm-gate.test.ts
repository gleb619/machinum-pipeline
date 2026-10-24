import { defineTool } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmHttpRequest } from '../src/llm-client.js'
import { LlmContextLengthError, LlmParseError } from '../src/llm-errors.js'
import {
  type GateState,
  createLlmGate,
  extractJson,
  llmGate,
  mockLlmCall,
} from '../src/llm-gate.js'
import { llmTranslate } from '../src/llm-translate.js'
import { chatCompletion, runPrompt } from '../src/openrouter-tool.js'

const ctx = {} as ToolContext
const ctxWith = (global: Record<string, unknown>): ToolContext =>
  ({ run: { global: { settings: {}, env: {}, ...global } } }) as unknown as ToolContext

afterEach(() => vi.unstubAllGlobals())

function stubFetch(content = 'pong') {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return new Response(
        JSON.stringify({
          choices: [{ message: { content } }],
          model: 'resp-model',
          usage: { total_tokens: 7, prompt_tokens: 4, completion_tokens: 3 },
        }),
        { status: 200 },
      )
    }),
  )
  return calls
}

describe('existing tools keep their contract', () => {
  it('chatCompletion posts legacy body to the router and returns the legacy shape', async () => {
    const calls = stubFetch()
    const out = await chatCompletion.invoke(
      {
        item: {
          messages: [{ role: 'user', content: 'ping' }],
          systemPrompt: 'be brief',
          temperature: 0.3,
          maxTokens: 50,
        },
        meta: { keep: 1 },
      },
      ctxWith({ routerUrl: 'http://router:9' }),
    )
    expect(calls[0]?.url).toBe('http://router:9/api/chat/completions')
    expect(calls[0]?.body).toEqual({
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'ping' },
      ],
      temperature: 0.3,
      max_tokens: 50,
    })
    expect(out.item).toEqual({
      content: 'pong',
      model: 'resp-model',
      tokens: 7,
      promptTokens: 4,
      completionTokens: 3,
    })
    expect(out.meta).toMatchObject({ keep: 1, chatCompletion: true, count: 1 })
    expect(out.meta.llmUsage).toMatchObject({ totalTokens: 7, calls: 1 })
  })

  it('chatCompletion batch: item is the array of outputs (legacy)', async () => {
    stubFetch()
    const mk = (t: string) => ({ messages: [{ role: 'user' as const, content: t }] })
    const out = await chatCompletion.invoke(
      { item: mk('a'), items: [mk('a'), mk('b')], meta: {} },
      ctxWith({ routerUrl: 'http://r' }),
    )
    expect(Array.isArray(out.item)).toBe(true)
    expect(out.meta.count).toBe(2)
  })

  it('runPrompt wraps prompt into a user message', async () => {
    const calls = stubFetch()
    const out = await runPrompt.invoke(
      { item: { prompt: 'hello', model: 'x/y', systemPrompt: 'sys' }, meta: {} },
      ctxWith({ routerUrl: 'http://r' }),
    )
    expect(calls[0]?.body.model).toBe('x/y')
    expect(calls[0]?.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ])
    expect(out.meta).toMatchObject({ runPrompt: true, count: 1 })
  })

  it('failures keep the legacy message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 400 })),
    )
    await expect(
      chatCompletion.invoke(
        { item: { messages: [{ role: 'user', content: 'x' }] }, meta: {} },
        ctxWith({ routerUrl: 'http://r' }),
      ),
    ).rejects.toThrow('Chat completion failed: 400 nope')
  })

  it('exposes slots prepare/fit/call/parse/emit', () => {
    expect(Object.keys(chatCompletion.slots)).toEqual(['prepare', 'fit', 'call', 'parse', 'emit'])
  })
})

describe('slot override', () => {
  const input = { messages: [{ role: 'user' as const, content: 'q' }] }

  it('mockLlmCall replaces call: no network, original untouched', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const mock = mockLlmCall(['first', 'second'])
    const gate = chatCompletion.with({ call: mock })
    const a = await gate.invoke({ item: input, meta: {} }, ctx)
    const b = await gate.invoke({ item: input, meta: {} }, ctx)
    expect((a.item as { content: string }).content).toBe('first')
    expect((b.item as { content: string }).content).toBe('second')
    expect(mock.calls).toHaveLength(2)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(chatCompletion.slots.call).not.toBe(mock)
  })

  it('mockLlmCall accepts a function and sees the prepared request', async () => {
    const gate = chatCompletion.with({
      call: mockLlmCall((req) => `echo:${req.messages.at(-1)?.content}:${req.model}`),
    })
    const out = await gate.invoke({ item: { ...input, model: 'm1' }, meta: {} }, ctx)
    expect((out.item as { content: string }).content).toBe('echo:q:m1')
  })

  it('swap fit with a custom function slot', async () => {
    const mock = mockLlmCall(['ok'])
    const gate = chatCompletion.with({
      call: mock,
      fit: async (env: { item: unknown; meta: Record<string, unknown> }) => {
        const s = env.item as GateState
        const request = s.request as NonNullable<GateState['request']>
        return {
          ...env,
          item: { ...s, request: { ...request, messages: request.messages.slice(-1) } },
        }
      },
    })
    await gate.invoke(
      {
        item: {
          messages: [
            { role: 'user', content: 'old' },
            { role: 'assistant', content: 'older' },
            { role: 'user', content: 'new' },
          ],
        },
        meta: {},
      },
      ctx,
    )
    expect(mock.calls[0]?.messages).toEqual([{ role: 'user', content: 'new' }])
  })

  it('unknown slot name throws', () => {
    expect(() => chatCompletion.with({ nope: mockLlmCall() } as never)).toThrow(/no slot 'nope'/)
  })

  it('swap built-in fit strategy via gate factory options', async () => {
    const msgs = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: `m${i}`.padEnd(40, '.'),
    }))
    const mk = (strategies: string[]) => {
      const mock = mockLlmCall(['ok'])
      const gate = createLlmGate({
        name: 'g',
        context: { maxTokens: 30, strategies, countTokens: (t) => Math.ceil(t.length / 4) },
      }).with({ call: mock })
      return { gate, mock }
    }
    const a = mk(['dropOldest'])
    const outA = await a.gate.invoke({ item: { messages: msgs }, meta: {} }, ctx)
    expect(a.mock.calls[0]?.messages.length).toBeLessThan(6)
    expect(a.mock.calls[0]?.messages.at(-1)?.content).toBe(msgs[5]?.content)
    expect(outA.meta.contextWindow).toMatchObject({ budget: 30, applied: [{ name: 'dropOldest' }] })
  })
})

describe('prompt customization through the gate', () => {
  const tin = { text: 'Hello', targetLang: 'ru', sourceLang: 'en' }

  it('default templates', async () => {
    const mock = mockLlmCall(['  Привет  '])
    const out = await llmTranslate.with({ call: mock }).invoke({ item: tin, meta: {} }, ctx)
    expect(mock.calls[0]?.messages[0]?.content).toContain('from en to ru')
    expect(mock.calls[0]?.messages[1]).toEqual({ role: 'user', content: 'Hello' })
    expect(out.item).toMatchObject({ translatedText: 'Привет' })
    expect(out.meta.translated).toBe(true)
  })

  it('meta.prompts override', async () => {
    const mock = mockLlmCall(['x'])
    await llmTranslate
      .with({ call: mock })
      .invoke({ item: tin, meta: { prompts: { 'translate.system': 'META {{targetLang}}' } } }, ctx)
    expect(mock.calls[0]?.messages[0]?.content).toBe('META ru')
  })

  it('env (ctx env) and settings override', async () => {
    const mock = mockLlmCall(['x'])
    await llmTranslate
      .with({ call: mock })
      .invoke(
        { item: tin, meta: {} },
        ctxWith({ env: { MT_PROMPT_TRANSLATE_SYSTEM: 'ENV {{targetLang}}' } }),
      )
    expect(mock.calls[0]?.messages[0]?.content).toBe('ENV ru')
    await llmTranslate.with({ call: mock }).invoke(
      { item: tin, meta: {} },
      ctxWith({
        settings: { 'prompts.translate.system': 'SET {{targetLang}}' },
        env: { MT_PROMPT_TRANSLATE_SYSTEM: 'ENV' },
      }),
    )
    expect(mock.calls[1]?.messages[0]?.content).toBe('SET ru')
  })

  it('factory option wins; missing var is a clear error', async () => {
    const g = createLlmGate({
      name: 'g',
      prompts: { 'translate.system': 'TOOL {{nope}}' },
      normalize: () => ({
        systemPromptName: 'translate.system',
        prompt: 'u',
        vars: {},
      }),
    }).with({ call: mockLlmCall() })
    await expect(g.invoke({ item: {}, meta: {} }, ctx)).rejects.toThrow(/missing variable.*nope/)
  })
})

describe('json mode / parse slot', () => {
  const jin = { prompt: 'give json', responseFormat: 'json' as const }

  it('extractJson handles fences and prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('Sure! {"a":[1,2]} done')).toEqual({ a: [1, 2] })
    expect(() => extractJson('nothing')).toThrow()
  })

  it('parses valid json into output.json', async () => {
    const out = await llmGate
      .with({ call: mockLlmCall(['{"ok":true}']) })
      .invoke({ item: jin, meta: {} }, ctx)
    expect((out.item as { json: unknown }).json).toEqual({ ok: true })
  })

  it('corrective retry: asks again with a correction message, bounded', async () => {
    const mock = mockLlmCall(['not json', '{"fixed":1}'])
    const out = await llmGate.with({ call: mock }).invoke({ item: jin, meta: {} }, ctx)
    expect((out.item as { json: unknown }).json).toEqual({ fixed: 1 })
    expect(mock.calls).toHaveLength(2)
    const second = mock.calls[1]?.messages ?? []
    expect(second.at(-2)).toEqual({ role: 'assistant', content: 'not json' })
    expect(second.at(-1)?.content).toMatch(/not valid JSON/)
    expect((out.meta.llmUsage as { calls: number }).calls).toBe(2)
  })

  it('gives up after jsonRetries with LlmParseError', async () => {
    const mock = mockLlmCall(['bad'])
    const gate = createLlmGate({ name: 'g', jsonRetries: 1 }).with({ call: mock })
    await expect(gate.invoke({ item: jin, meta: {} }, ctx)).rejects.toBeInstanceOf(LlmParseError)
    expect(mock.calls).toHaveLength(2)
  })

  it('validate() rejection triggers a retry too', async () => {
    const mock = mockLlmCall(['{"n":"x"}', '{"n":2}'])
    const gate = createLlmGate({
      name: 'g',
      validate: (j) => {
        if (typeof (j as { n: unknown }).n !== 'number') throw new Error('n must be number')
        return j
      },
    }).with({ call: mock })
    const out = await gate.invoke({ item: jin, meta: {} }, ctx)
    expect((out.item as { json: unknown }).json).toEqual({ n: 2 })
  })
})

describe('context-length shrink-and-retry', () => {
  const big = {
    messages: [
      { role: 'system' as const, content: 'sys' },
      ...Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 ? ('assistant' as const) : ('user' as const),
        content: `turn${i} ${'w'.repeat(80)}`,
      })),
      { role: 'user' as const, content: 'final question' },
    ],
  }

  it('shrinks via fit slot and retries when enabled', async () => {
    let n = 0
    const mock = mockLlmCall(
      (req) => {
        n++
        if (n === 1) return new LlmContextLengthError('too long')
        return `ok:${req.messages.length}`
      },
      { shrinkOnContextError: true },
    )
    const gate = createLlmGate({ name: 'g', shrinkOnContextError: true }).with({ call: mock })
    const out = await gate.invoke({ item: big, meta: {} }, ctx)
    expect(mock.calls).toHaveLength(2)
    expect(mock.calls[1]?.messages.length).toBeLessThan(mock.calls[0]?.messages.length ?? 0)
    expect(mock.calls[1]?.messages.at(-1)?.content).toBe('final question')
    expect(mock.calls[1]?.messages[0]?.role).toBe('system')
    expect((out.meta.contextWindow as { applied: unknown[] }).applied.length).toBeGreaterThan(0)
  })

  it('disabled by default: error surfaces', async () => {
    const mock = mockLlmCall(() => new LlmContextLengthError('too long'))
    await expect(
      chatCompletion.with({ call: mock }).invoke({ item: big, meta: {} }, ctx),
    ).rejects.toBeInstanceOf(LlmContextLengthError)
    expect(mock.calls).toHaveLength(1)
  })

  it('real call slot: transport 400 context error -> shrink -> success', async () => {
    const seen: LlmHttpRequest[] = []
    const gate = createLlmGate({
      name: 'g',
      shrinkOnContextError: 2,
      llm: { retry: { max: 0, backoffMs: 0, strategy: 'fixed' } },
      transport: async (r) => {
        seen.push(r)
        return seen.length === 1
          ? { status: 400, body: 'This model maximum context length is 100 tokens' }
          : {
              status: 200,
              body: JSON.stringify({ choices: [{ message: { content: 'fine' } }], usage: {} }),
            }
      },
    })
    const out = await gate.invoke({ item: big, meta: {} }, ctx)
    expect((out.item as { content: string }).content).toBe('fine')
    expect(seen).toHaveLength(2)
    expect(JSON.parse(seen[1]?.body ?? '{}').messages.length).toBeLessThan(
      JSON.parse(seen[0]?.body ?? '{}').messages.length,
    )
  })
})

describe('config reaches the call slot', () => {
  it('per-call llm layer > tool > meta; provider/baseUrl/apiKey honoured, usage + cost in meta', async () => {
    const seen: LlmHttpRequest[] = []
    const gate = createLlmGate({
      name: 'g',
      llm: { provider: 'openai', model: 'tool-model', apiKey: 'sk-tool' },
      transport: async (r) => {
        seen.push(r)
        return {
          status: 200,
          body: JSON.stringify({
            choices: [{ message: { content: 'x' } }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: 0.5 },
          }),
        }
      },
    })
    const out = await gate.invoke(
      {
        item: { prompt: 'p', llm: { baseUrl: 'http://local:1/v1' } },
        meta: { llm: { model: 'meta-model' } },
      },
      ctx,
    )
    expect(seen[0]?.url).toBe('http://local:1/v1/chat/completions')
    expect(seen[0]?.headers.Authorization).toBe('Bearer sk-tool')
    expect(JSON.parse(seen[0]?.body ?? '{}').model).toBe('tool-model')
    expect(out.meta.llmUsage).toMatchObject({ totalTokens: 3, costUsd: 0.5, calls: 1 })
  })

  it('custom slot tool can be a defineTool', async () => {
    const custom = defineTool<GateState, GateState>({
      name: 'c',
      version: '1',
      mdDescription: 'c',
      invoke: async (env) => ({
        ...env,
        item: {
          ...env.item,
          response: {
            content: 'custom',
            model: 'c',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          },
        },
      }),
    })
    const out = await llmGate
      .with({ call: custom })
      .invoke({ item: { prompt: 'x' }, meta: {} }, ctx)
    expect((out.item as { content: string }).content).toBe('custom')
  })
})
