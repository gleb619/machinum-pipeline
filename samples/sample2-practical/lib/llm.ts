import { resolve } from 'node:path'
import { createBookLlmPicker } from '@mt/bookkit'
import { createConsoleLogger } from '@mt/core'
import { type LlmChoice, type PickLlmToolOptions, readLlmConfig } from '@mt/tools'

/**
 * The single LLM config point of the sample: every pipe picks its backend here.
 *
 * `MT_LLM_TOOL` / `MT_LLM_MODEL` or mt.json `settings.llm.*` (plus the gitignored
 * `mt.local.json` that mt.json imports) choose the backend; the default is the offline
 * `mock`, so the pipes and their tests run without credentials and without network.
 *
 * The generic picker lives in `@mt/bookkit`; this file only chooses the sample policy:
 * free OpenRouter ids unless `MT_ALLOW_PAID=1`, and a real backend unless `MT_ALLOW_MOCK=1`.
 */

export { ROOT } from './config.js'

const sampleRoot = resolve(import.meta.dirname, '..')

/** The sample `mt.json` (with its `mt.local.json` imports) every LLM check reads. */
export const llmConfigPath = resolve(sampleRoot, 'mt.json')

const picker = createBookLlmPicker({
  root: sampleRoot,
  configPath: llmConfigPath,
  logger: createConsoleLogger(),
  guard: { freeOnly: true, requireRealBackend: true },
})

export const { modelEnvVar, gateLayer } = picker
export { assertFreeModel } from '@mt/bookkit'
export const assertRealBackend = (tool: string, backend: string): void => {
  if (backend !== 'mock') return
  if (process.env.MT_ALLOW_MOCK === '1') return
  if (process.env.VITEST) return
  throw new Error(
    `[${tool}] backend is 'mock': every stage would emit fake text and the run would still exit 0. Fix: set settings."llm.tool" in samples/sample2-practical/mt.local.json (e.g. "router" plus a ":free" llm.model.<stage> id), or set MT_ALLOW_MOCK=1 for a deliberate offline run.`,
  )
}

/** Cheap config-only check; it resolves no backend and logs nothing. */
export function usesMockBackend(): boolean {
  return readLlmConfig(process.env, llmConfigPath).tool === 'mock'
}

/** The LLM backend for one pipe (`tool` = the pipe name, e.g. `summary`). */
export function pickFor(tool: string, mockSource?: PickLlmToolOptions['mockSource']): LlmChoice {
  return picker.pickFor(tool, mockSource)
}
