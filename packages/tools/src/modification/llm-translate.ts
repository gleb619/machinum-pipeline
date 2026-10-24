import type { TranslateInput, TranslateOutput } from './translate-text.js'
import { createTranslateGate } from './translate-text.js'

export type LlmTranslateInput = TranslateInput
export type LlmTranslateOutput = TranslateOutput

/**
 * Direct-to-LLM translation gate (no router `/api/translate`). Same shared
 * implementation as `translateText` with the LLM call backend; prompts are
 * templates `translate.system` / `translate.user` - override via tool option,
 * `meta.prompts`, mt.json `prompts.translate.system`, or env
 * `MT_PROMPT_TRANSLATE_SYSTEM`.
 */
export const llmTranslate = createTranslateGate(
  'llm-translate',
  {},
  'Translates text with an LLM using overridable prompt templates (translate.system / translate.user).',
)

export type { GateOutput } from '../verification/llm-gate.js'
