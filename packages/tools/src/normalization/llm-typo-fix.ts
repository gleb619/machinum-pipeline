import { defineTool, setVariable, withItem } from '@mt/core'
import type { SchemaDocLlmCall } from './schema/llm.js'

/** Variable telling whether the LLM reply was applied. */
export const VAR_LLM_FIXED = 'llmFixed'

export const LLM_TYPO_FIX_PROMPT =
  'Fix only obvious typos and punctuation mistakes. Keep the meaning, wording, [bracketed] ' +
  'system messages and the number of lines unchanged. Reply with the corrected text only.'

export interface LlmTypoFixOptions {
  /** LLM backend (e.g. `pickLlmTool().schemaCall`). */
  call: SchemaDocLlmCall
  /** `false` -> pass-through (no LLM call). Default: true. */
  enabled?: boolean
  /** Override the system prompt. */
  systemPrompt?: string
}

/**
 * Optional LLM typo fix of `env.item` (plain text). A reply with a different line count is
 * rejected (original kept). variable `llmFixed` tells whether the reply was applied.
 */
export function createLlmTypoFix(options: LlmTypoFixOptions) {
  const enabled = options.enabled ?? true
  return defineTool<string, string>({
    name: enabled ? 'llm-typo-fix' : 'llm-typo-fix-off',
    version: '1.0.0',
    mdDescription: enabled
      ? 'Fixes typos through the picked LLM backend; keeps the line count.'
      : 'Pass-through (LLM typo fix disabled).',
    async invoke(env, ctx) {
      if (!enabled) return env
      const res = await options.call(
        {
          systemPrompt: options.systemPrompt ?? LLM_TYPO_FIX_PROMPT,
          messages: [{ role: 'user', content: env.item }],
        },
        ctx,
      )
      const fixed = res.content.trim()
      const same = fixed.split('\n').length === env.item.split('\n').length
      return setVariable(withItem(env, same ? fixed : env.item), VAR_LLM_FIXED, same)
    },
  })
}
