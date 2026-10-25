import { defineTool } from '@mt/core'
import type { SchemaDocLlmCall, SchemaDocLlmOptions } from './schema/llm.js'
import { createSummaryTool } from './schema/summary.js'

export interface LlmSummaryToolOptions extends Omit<SchemaDocLlmOptions, 'call'> {
  /** LLM backend (e.g. `pickLlmTool().schemaCall`). */
  call: SchemaDocLlmCall
  /** `false` -> pass-through (keeps the heuristic summary). Default: true. */
  enabled?: boolean
}

/**
 * LLM summary (`createSummaryTool`) that, for every chapter the LLM could not summarise
 * (`meta.summaryLlm.fallbackUsed`), swaps in the heuristic summary from `heuristicSummaryTool`
 * (`meta.heuristicSummaryByItem`). Run it after `heuristicSummaryTool`.
 */
export function createLlmSummaryWithFallback(options: LlmSummaryToolOptions) {
  const { enabled = true, ...llmOptions } = options
  const inner = createSummaryTool(llmOptions)
  return defineTool<string | string[], string | string[]>({
    name: enabled ? 'llm-summary-with-fallback' : 'llm-summary-off',
    version: '1.0.0',
    mdDescription: enabled
      ? 'LLM summary through the picked backend; heuristic summary on fallback.'
      : 'Pass-through (LLM summary disabled).',
    async invoke(env, ctx) {
      if (!enabled) return env
      const out = await inner.invoke(env as never, ctx)
      const failed = (out.meta.summaryLlm as { fallbackUsed?: boolean } | undefined)?.fallbackUsed
      if (!failed) return out as never
      const heuristic = out.meta.heuristicSummaryByItem as string[]
      return {
        ...out,
        meta: { ...out.meta, summaryByItem: heuristic, summary: heuristic[0] },
      } as never
    },
  })
}
