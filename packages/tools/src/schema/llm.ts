import type { ToolContext } from '@mt/core'
import { chatCompletionSingle } from '../openrouter-tool.js'
import type { ChatCompletionInput } from '../openrouter-tool.js'

export const DEFAULT_LLM_MODEL = 'openai/gpt-4o-mini'
export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_ROUTER_URL = 'http://localhost:7777'

/**
 * LLM knobs shared by every schema-doc extraction tool. Prompts are templates:
 * `{{name}}` placeholders are rendered per chapter (see `renderPrompt`).
 */
export interface SchemaDocLlmOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  systemPrompt?: string
  userPrompt?: string
  /** Loop-guard budget: LLM calls per chapter before the deterministic fallback. */
  maxAttempts?: number
  routerUrl?: string
}

export type PromptValidation<T> = { ok: true; value: T } | { ok: false; reason: string }

export interface PromptRetryOptions<T> extends SchemaDocLlmOptions {
  systemPrompt: string
  userPrompt: string
  validate: (content: string) => PromptValidation<T>
}

export interface PromptRetryResult<T> {
  ok: boolean
  value?: T
  content: string
  attempts: number
  failures: string[]
  lastFailure?: string
  model?: string
  tokens: number
}

/**
 * Sends one user message with a system prompt through the OpenRouter proxy and
 * re-prompts with rejection feedback until `validate` accepts the answer.
 *
 * Never throws: transport errors and rejected answers are recorded as failures,
 * and the caller falls back to its deterministic parse after `maxAttempts`.
 */
export async function runPromptWithRetry<T>(
  ctx: ToolContext,
  options: PromptRetryOptions<T>,
): Promise<PromptRetryResult<T>> {
  const routerUrl = options.routerUrl ?? ctx.run?.global?.routerUrl ?? DEFAULT_ROUTER_URL
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))

  let prompt = options.userPrompt
  let content = ''
  let tokens = 0
  let model: string | undefined
  let attempts = 0
  const failures: string[] = []

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt
    const chatInput: ChatCompletionInput = {
      messages: [{ role: 'user', content: prompt }],
      model: options.model ?? DEFAULT_LLM_MODEL,
      systemPrompt: options.systemPrompt,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    }

    try {
      const result = await chatCompletionSingle(chatInput, routerUrl)
      tokens += result.tokens
      model = result.model
      content = result.content.trim()

      if (!content) {
        failures.push('the response was empty')
      } else {
        const validated = options.validate(content)
        if (validated.ok) {
          return {
            ok: true,
            value: validated.value,
            content,
            attempts,
            failures,
            model,
            tokens,
          }
        }
        failures.push(validated.reason)
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }

    prompt = withFeedback(options.userPrompt, attempt, maxAttempts, failures[failures.length - 1])
  }

  return {
    ok: false,
    content,
    attempts,
    failures,
    lastFailure: failures[failures.length - 1],
    model,
    tokens,
  }
}

function withFeedback(userPrompt: string, attempt: number, maxAttempts: number, reason?: string) {
  return [
    userPrompt,
    '',
    `Your previous answer was rejected (attempt ${attempt} of ${maxAttempts}): ${reason ?? 'unknown reason'}`,
    'Answer again, fixing exactly that, and reply with the required format only.',
  ].join('\n')
}

/** Per-tool LLM diagnostics written into `meta.<key>Llm`. */
export interface LlmAttemptMeta {
  attempts: number
  tokens: number
  model?: string
  fallbackUsed: boolean
  lastFailure?: string
}

export function attemptMeta(results: PromptRetryResult<unknown>[]): LlmAttemptMeta {
  const failed = results.filter((result) => !result.ok)
  return {
    attempts: results.reduce((total, result) => total + result.attempts, 0),
    tokens: results.reduce((total, result) => total + result.tokens, 0),
    model: results[0]?.model,
    fallbackUsed: failed.length > 0,
    lastFailure: failed[failed.length - 1]?.lastFailure,
  }
}

/**
 * Resolves effective options: tool defaults < tool options < `meta.schemaDocLlm`
 * < `meta.<key>Prompt` / `meta.<key>SystemPrompt` per-envelope overrides.
 */
export function resolveLlmOptions(
  toolOptions: SchemaDocLlmOptions,
  meta: Record<string, unknown> | undefined,
  key: string,
): SchemaDocLlmOptions {
  const fromMeta = pickOptions(meta?.schemaDocLlm)
  const prompt = meta?.[`${key}Prompt`]
  const systemPrompt = meta?.[`${key}SystemPrompt`]

  const resolved: SchemaDocLlmOptions = { ...toolOptions, ...fromMeta }
  if (typeof prompt === 'string') {
    resolved.userPrompt = prompt
  }
  if (typeof systemPrompt === 'string') {
    resolved.systemPrompt = systemPrompt
  }
  return resolved
}

function pickOptions(value: unknown): SchemaDocLlmOptions {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const source = value as Record<string, unknown>
  const options: SchemaDocLlmOptions = {}
  if (typeof source.model === 'string') options.model = source.model
  if (typeof source.temperature === 'number') options.temperature = source.temperature
  if (typeof source.maxTokens === 'number') options.maxTokens = source.maxTokens
  if (typeof source.maxAttempts === 'number') options.maxAttempts = source.maxAttempts
  if (typeof source.routerUrl === 'string') options.routerUrl = source.routerUrl
  if (typeof source.systemPrompt === 'string') options.systemPrompt = source.systemPrompt
  if (typeof source.userPrompt === 'string') options.userPrompt = source.userPrompt
  return options
}
