import { Cache } from '@mt/core'
import type { ToolContext } from '@mt/core'
import { describe, expect, it, vi } from 'vitest'
import type { LlmClient, LlmRequest, LlmResponse } from '../src/core/llm-client.js'
import { createLlmGate, mockLlmCall } from '../src/core/llm-gate.js'
import { varsOf } from './helpers/llm-vars.js'

// The only transport with real streaming is the SDK one; `createLlmClient` builds it from config.
const openAiCreate = vi.hoisted(() => vi.fn())

vi.mock('openai', () => {
  class MockOpenAI {
    chat = { completions: { create: openAiCreate } }
  }
  return { default: MockOpenAI }
})

const ctx = {} as ToolContext

function streamingClient(onStreamCall: (req: LlmRequest) => void) {
  const chatCompletion = vi.fn(
    async (req: LlmRequest): Promise<LlmResponse> => ({
      content: 'nonstream',
      model: req.model,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }),
  )
  const chatCompletionStream = vi.fn(async (req: LlmRequest, onDelta?: (d: string) => void) => {
    onStreamCall(req)
    for (const d of ['a', 'b', 'c']) onDelta?.(d)
    return {
      content: 'abc',
      model: req.model,
      usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
    }
  })
  const client: LlmClient & { chatCompletion: typeof chatCompletion } = {
    chatCompletion,
    chatCompletionStream,
  }
  return { client, chatCompletion, chatCompletionStream }
}

describe('gate stream option', () => {
  it('stream: true uses chatCompletionStream and keeps the envelope shape', async () => {
    const { client, chatCompletion, chatCompletionStream } = streamingClient(() => {})
    const deltas: string[] = []
    const gate = createLlmGate<{ prompt: string }, unknown>({
      name: 'stream-gate',
      client,
      stream: true,
      onDelta: (d, input) => {
        deltas.push(d)
        expect(input).toMatchObject({ prompt: 'hi' })
      },
    })
    const out = await gate.invoke(
      { id: 'ex-test', variables: [], item: { prompt: 'hi' }, meta: {} },
      ctx,
    )
    expect(chatCompletionStream).toHaveBeenCalledTimes(1)
    expect(chatCompletion).not.toHaveBeenCalled()
    expect(deltas).toEqual(['a', 'b', 'c'])
    expect(out.item).toMatchObject({ content: 'abc', tokens: 5 })
    expect(varsOf(out)).toMatchObject({ count: 1, llmUsage: { totalTokens: 5, calls: 1 } })
  })

  it('falls back to chatCompletion when the client cannot stream', async () => {
    const chatCompletion = vi.fn(
      async (req: LlmRequest): Promise<LlmResponse> => ({
        content: 'plain',
        model: req.model,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    )
    const gate = createLlmGate<{ prompt: string }, unknown>({
      name: 'nostream-gate',
      client: { chatCompletion },
      stream: true,
      onDelta: () => expect.unreachable('onDelta without streaming'),
    })
    const out = await gate.invoke(
      { id: 'ex-test', variables: [], item: { prompt: 'hi' }, meta: {} },
      ctx,
    )
    expect(chatCompletion).toHaveBeenCalledTimes(1)
    expect(out.item).toMatchObject({ content: 'plain' })
  })

  it('stream: false / unset never calls chatCompletionStream', async () => {
    const { client, chatCompletion, chatCompletionStream } = streamingClient(() => {})
    const gate = createLlmGate<{ prompt: string }, unknown>({ name: 'off-gate', client })
    await gate.invoke({ id: 'ex-test', variables: [], item: { prompt: 'hi' }, meta: {} }, ctx)
    expect(chatCompletion).toHaveBeenCalledTimes(1)
    expect(chatCompletionStream).not.toHaveBeenCalled()
  })

  it('mockLlmCall still works as a call slot on a streaming gate', async () => {
    const gate = createLlmGate<{ prompt: string }, unknown>({
      name: 'mock-stream-gate',
      stream: true, // ignored by the mock call slot
    })
    const out = await gate
      .with({ call: mockLlmCall(['answer']) })
      .invoke({ id: 'ex-test', variables: [], item: { prompt: 'hi' }, meta: {} }, ctx)
    expect(out.item).toMatchObject({ content: 'answer' })
  })
})

describe('gate stream option through createLlmClient (decorators)', () => {
  // `createLlmClient` is the only client real pipelines build: the decorators must not drop
  // `chatCompletionStream`, otherwise `stream: true` silently degrades to a buffered call.
  const sdkCfg = {
    llm: { provider: 'openai' as const, apiKey: 'sk-test', transport: 'sdk' as const },
  }

  const streamChunks = () =>
    (async function* () {
      yield { choices: [{ delta: { content: 'Hel' } }] }
      yield { choices: [{ delta: { content: 'lo' } }] }
      yield { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 1, total_tokens: 3 } }
    })()

  it('stream: true reaches the SDK transport and fires onDelta', async () => {
    openAiCreate.mockReset()
    openAiCreate.mockResolvedValueOnce(streamChunks())
    const deltas: string[] = []
    const gate = createLlmGate<{ prompt: string }, unknown>({
      name: 'create-client-stream-gate',
      ...sdkCfg,
      stream: true,
      onDelta: (d) => deltas.push(d),
    })
    const out = await gate.invoke(
      { id: 'ex-test', variables: [], item: { prompt: 'hi' }, meta: {} },
      ctx,
    )
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(out.item).toMatchObject({ content: 'Hello', tokens: 3 })
    const params = openAiCreate.mock.calls[0]?.[0] as Record<string, unknown>
    expect(params.stream).toBe(true)
  })

  it('a cached stream replays the stored answer through onDelta', async () => {
    openAiCreate.mockReset()
    openAiCreate.mockResolvedValueOnce(streamChunks())
    const store = new Map<string, unknown>()
    const core = new Cache('/nonexistent')
    const cache = {
      computeKey: (o: { toolName: string; version: string; input: unknown }) => core.computeKey(o),
      get: async <T>(k: string) => store.get(k) as T | undefined,
      set: async (k: string, _o: unknown, v: unknown) => {
        store.set(k, v)
      },
    }
    const gate = createLlmGate<{ prompt: string }, unknown>({
      name: 'create-client-cached-stream-gate',
      ...sdkCfg,
      llm: { ...sdkCfg.llm, cache: true },
      cache,
      stream: true,
    })
    await gate.invoke({ id: 'ex-test', variables: [], item: { prompt: 'hi' }, meta: {} }, ctx)
    const deltas: string[] = []
    const replay = await createLlmGate<{ prompt: string }, unknown>({
      name: 'create-client-cached-stream-gate',
      ...sdkCfg,
      llm: { ...sdkCfg.llm, cache: true },
      cache,
      stream: true,
      onDelta: (d) => deltas.push(d),
    }).invoke({ id: 'ex-test', variables: [], item: { prompt: 'hi' }, meta: {} }, ctx)
    expect(openAiCreate).toHaveBeenCalledTimes(1)
    expect(deltas).toEqual(['Hello'])
    expect(replay.item).toMatchObject({ content: 'Hello' })
  })
})
