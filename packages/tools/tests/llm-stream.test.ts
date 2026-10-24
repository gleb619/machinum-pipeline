import type { ToolContext } from '@mt/core'
import { describe, expect, it, vi } from 'vitest'
import type { LlmClient, LlmRequest, LlmResponse } from '../src/llm-client.js'
import { createLlmGate, mockLlmCall } from '../src/llm-gate.js'

const ctx = {} as ToolContext

function streamingClient(onStreamCall: (req: LlmRequest) => void) {
  const chatCompletion = vi.fn(async (req: LlmRequest): Promise<LlmResponse> => ({
    content: 'nonstream',
    model: req.model,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }))
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
    const out = await gate.invoke({ item: { prompt: 'hi' }, meta: {} }, ctx)
    expect(chatCompletionStream).toHaveBeenCalledTimes(1)
    expect(chatCompletion).not.toHaveBeenCalled()
    expect(deltas).toEqual(['a', 'b', 'c'])
    expect(out.item).toMatchObject({ content: 'abc', tokens: 5 })
    expect(out.meta).toMatchObject({ count: 1, llmUsage: { totalTokens: 5, calls: 1 } })
  })

  it('falls back to chatCompletion when the client cannot stream', async () => {
    const chatCompletion = vi.fn(async (req: LlmRequest): Promise<LlmResponse> => ({
      content: 'plain',
      model: req.model,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }))
    const gate = createLlmGate<{ prompt: string }, unknown>({
      name: 'nostream-gate',
      client: { chatCompletion },
      stream: true,
      onDelta: () => expect.unreachable('onDelta without streaming'),
    })
    const out = await gate.invoke({ item: { prompt: 'hi' }, meta: {} }, ctx)
    expect(chatCompletion).toHaveBeenCalledTimes(1)
    expect(out.item).toMatchObject({ content: 'plain' })
  })

  it('stream: false / unset never calls chatCompletionStream', async () => {
    const { client, chatCompletion, chatCompletionStream } = streamingClient(() => {})
    const gate = createLlmGate<{ prompt: string }, unknown>({ name: 'off-gate', client })
    await gate.invoke({ item: { prompt: 'hi' }, meta: {} }, ctx)
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
      .invoke({ item: { prompt: 'hi' }, meta: {} }, ctx)
    expect(out.item).toMatchObject({ content: 'answer' })
  })
})
