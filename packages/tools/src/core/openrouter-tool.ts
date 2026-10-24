import type { ToolContext } from '@mt/core'
import { type LlmMessage, OpenAiCompatClient } from './llm-client.js'
import { DEFAULT_ROUTER_URL, readCtx } from './llm-config.js'
import { type GateInput, createLlmGate } from './llm-gate.js'

export { DEFAULT_ROUTER_URL }

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
  /** Ask for JSON output; the gate parses it into `json` (with corrective retries). */
  responseFormat?: GateInput['responseFormat']
  /** Per-call LLM config overrides (provider, model, baseUrl, timeoutMs, ...). */
  llm?: GateInput['llm']
  /** Per-call context-window overrides (maxTokens, contextLimit, reserve, strategies). */
  context?: GateInput['context']
}

export interface ChatCompletionOutput {
  content: string
  model: string
  tokens: number
  promptTokens: number
  completionTokens: number
  /** Parsed JSON when `responseFormat: 'json'`. */
  json?: unknown
}

export interface PromptInput {
  prompt: string
  model?: string
  systemPrompt?: string
  responseFormat?: GateInput['responseFormat']
  llm?: GateInput['llm']
  context?: GateInput['context']
}

export interface PromptOutput extends ChatCompletionOutput {}

/**
 * Resolve the router URL: run context first, then `MT_ROUTER_URL`, then default.
 * Empty values count as unset.
 */
export function resolveRouterUrl(ctx?: ToolContext): string {
  const fromContext = ctx?.run?.global?.routerUrl
  if (typeof fromContext === 'string' && fromContext.length > 0) return fromContext
  const fromEnv = readCtx(ctx).env.MT_ROUTER_URL
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return DEFAULT_ROUTER_URL
}

/** Per-request options for a single chat completion. */
export interface ChatCompletionOptions {
  /** Abort signal used to bound the request. */
  signal?: AbortSignal
}

/**
 * One-shot completion against the router proxy (no retry/cache/context management).
 * Prefer the `chatCompletion` gate; this stays for direct programmatic use.
 */
export async function chatCompletionSingle(
  input: ChatCompletionInput,
  routerUrl: string,
  options: ChatCompletionOptions = {},
): Promise<ChatCompletionOutput> {
  const messages: LlmMessage[] = []
  if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt })
  messages.push(...input.messages)
  const client = new OpenAiCompatClient({ baseUrl: routerUrl, chatPath: '/api/chat/completions' })
  const res = await client.chatCompletion({
    model: input.model ?? 'openai/gpt-4o-mini',
    messages,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    signal: options.signal,
  })
  return {
    content: res.content,
    model: res.model,
    tokens: res.usage.totalTokens,
    promptTokens: res.usage.promptTokens,
    completionTokens: res.usage.completionTokens,
  }
}

/**
 * Chat completion gate. Composable slots: prepare -> fit -> call -> parse -> emit
 * (`chatCompletion.with({ call: mockLlmCall([...]) })`). Provider defaults to the MT router proxy;
 * see llm-config for provider/model/baseUrl/key precedence.
 */
export const chatCompletion = createLlmGate<ChatCompletionInput, ChatCompletionOutput>({
  name: 'chat-completion',
  version: '1.0.0',
  mdDescription:
    'LLM chat completion via OpenRouter proxy. Supports system prompts, temperature, and max tokens.',
  metaFlags: { chatCompletion: true },
})

export const runPrompt = createLlmGate<PromptInput, PromptOutput>({
  name: 'run-prompt',
  version: '1.0.0',
  mdDescription: 'Simplified single-prompt runner. Wraps `chat-completion` with a user message.',
  metaFlags: { runPrompt: true },
})
