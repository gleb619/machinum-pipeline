import { defineTool, setVariable, withItem } from '@mt/core'
import {
  type ChunkModeOptions,
  resolvePromptBudget,
  runChunkedText,
  toChunkRecord,
} from '../core/chunk-processor.js'
import type { SchemaDocLlmCall } from './schema/llm.js'

/** Variable telling whether the LLM reply was applied. */
export const VAR_LLM_FIXED = 'llmFixed'

export const LLM_TYPO_FIX_PROMPT =
  'Fix only obvious typos and punctuation mistakes. Keep the meaning, wording, [bracketed] ' +
  'system messages and the number of lines unchanged. Reply with the corrected text only.'

export interface LlmTypoFixOptions extends ChunkModeOptions {
  /** LLM backend (e.g. `pickLlmTool().schemaCall`). */
  call: SchemaDocLlmCall
  /** `false` -> pass-through (no LLM call). Default: true. */
  enabled?: boolean
  /** Override the system prompt. */
  systemPrompt?: string
  /** Model id used for the chunk budget lookup and passed to the backend. */
  model?: string
}

/**
 * Optional LLM typo fix of `env.item` (plain text). A reply with a different line count is
 * rejected (original kept). variable `llmFixed` tells whether the reply was applied.
 */
export function createLlmTypoFix(options: LlmTypoFixOptions) {
  const enabled = options.enabled ?? true
  return defineTool<string, string>({
    name: enabled ? 'llm-typo-fix' : 'llm-typo-fix-off',
    version: '1.1.0',
    mdDescription: enabled
      ? 'Fixes typos through the picked LLM backend; keeps the line count. Supports shrink/chunk/auto modes (a chunk whose reply changes the line count keeps its original text).'
      : 'Pass-through (LLM typo fix disabled).',
    async invoke(env, ctx) {
      if (!enabled) return env
      const systemPrompt = options.systemPrompt ?? LLM_TYPO_FIX_PROMPT
      let allApplied = true
      const fixOne = async (text: string): Promise<string> => {
        const res = await options.call(
          {
            systemPrompt,
            messages: [{ role: 'user', content: text }],
            ...(options.model ? { model: options.model } : {}),
          },
          ctx,
        )
        const fixed = res.content.trim()
        if (fixed.split('\n').length === text.split('\n').length) return fixed
        allApplied = false
        return text
      }
      const run = await runChunkedText<string>({
        mode: options.chunkMode,
        text: env.item,
        budget: () => resolvePromptBudget(ctx, { model: options.model }, options, [systemPrompt]),
        single: () => fixOne(env.item),
        chunk: fixOne,
        merge: (parts) => parts.join('\n\n'),
        splitUnit: options.splitUnit,
        concurrency: options.chunkConcurrency,
      })
      const next = setVariable(withItem(env, run.value), VAR_LLM_FIXED, allApplied)
      return run.budget
        ? setVariable(next, 'llmTypoFixChunks', toChunkRecord(run.budget, run.chunks))
        : next
    },
  })
}
