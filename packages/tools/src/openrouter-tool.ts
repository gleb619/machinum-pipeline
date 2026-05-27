import { defineTool } from '@mt/core'
import type { Envelope, ToolContext } from '@mt/core'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletionInput {
  messages: ChatMessage[]
  model?: string
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
}

export interface ChatCompletionOutput {
  content: string
  model: string
  tokens: number
  promptTokens: number
  completionTokens: number
}

export interface PromptInput {
  prompt: string
  model?: string
  systemPrompt?: string
}

export interface PromptOutput extends ChatCompletionOutput {}

async function chatCompletionSingle(
  input: ChatCompletionInput,
  routerUrl: string,
): Promise<ChatCompletionOutput> {
  const messages: ChatMessage[] = []
  if (input.systemPrompt) {
    messages.push({ role: 'system', content: input.systemPrompt })
  }
  messages.push(...input.messages)

  const body: Record<string, unknown> = {
    model: input.model ?? 'openai/gpt-4o-mini',
    messages,
  }
  if (input.temperature !== undefined) {
    body.temperature = input.temperature
  }
  if (input.maxTokens !== undefined) {
    body.max_tokens = input.maxTokens
  }

  const url = new URL('/api/chat/completions', routerUrl)
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Chat completion failed: ${response.status} ${error}`)
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>
    model: string
    usage: {
      total_tokens: number
      prompt_tokens: number
      completion_tokens: number
    }
  }

  return {
    content: data.choices[0]?.message?.content ?? '',
    model: data.model,
    tokens: data.usage.total_tokens,
    promptTokens: data.usage.prompt_tokens,
    completionTokens: data.usage.completion_tokens,
  }
}

export const chatCompletion = defineTool<ChatCompletionInput, ChatCompletionOutput>({
  name: 'chat-completion',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(
    env: Envelope<ChatCompletionInput>,
    ctx: ToolContext,
  ): Promise<Envelope<ChatCompletionOutput>> {
    const routerUrl = ctx.run.global.routerUrl ?? 'http://localhost:7777'
    const inputs = env.items ?? [env.item]

    const results: ChatCompletionOutput[] = []
    for (const input of inputs) {
      const result = await chatCompletionSingle(input, routerUrl)
      results.push(result)
    }

    const output = env.items ? results : results[0]
    return {
      item: output as ChatCompletionOutput,
      meta: {
        ...env.meta,
        chatCompletion: true,
        count: results.length,
      },
    }
  },
})

export const runPrompt = defineTool<PromptInput, PromptOutput>({
  name: 'run-prompt',
  version: '1.0.0',
  exec: 'inproc',
  async invoke(env: Envelope<PromptInput>, ctx: ToolContext): Promise<Envelope<PromptOutput>> {
    const routerUrl = ctx.run.global.routerUrl ?? 'http://localhost:7777'
    const inputs = env.items ?? [env.item]

    const results: PromptOutput[] = []
    for (const input of inputs) {
      const chatInput: ChatCompletionInput = {
        messages: [{ role: 'user', content: input.prompt }],
        model: input.model,
        systemPrompt: input.systemPrompt,
      }
      const result = await chatCompletionSingle(chatInput, routerUrl)
      results.push(result)
    }

    const output = env.items ? results : results[0]
    return {
      item: output as PromptOutput,
      meta: {
        ...env.meta,
        runPrompt: true,
        count: results.length,
      },
    }
  },
})
