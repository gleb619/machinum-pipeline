import type { TranslateInput, TranslateOutput, TranslateTextOptions } from './translate-text.js'
import {
  type TranslateToolLike,
  createChunkedTranslateText,
  createTranslateGate,
} from './translate-text.js'

export type LlmTranslateInput = TranslateInput
export type LlmTranslateOutput = TranslateOutput

const DESCRIPTION =
  'Translates text with an LLM using overridable prompt templates (translate.system / translate.user).'

/**
 * Direct-to-LLM translation gate (no router `/api/translate`). Same shared
 * implementation as `translateText` with the LLM call backend; prompts are
 * templates `translate.system` / `translate.user` - override via tool option,
 * `meta.prompts`, mt.json `prompts.translate.system`, or env
 * `MT_PROMPT_TRANSLATE_SYSTEM`.
 *
 * Accepts the shared chunk options (`chunkMode` shrink|chunk|auto, default `shrink` = the bare
 * gate); chunking uses the same wrapper as `translateText`.
 */
export function createLlmTranslate(options: TranslateTextOptions = {}): TranslateToolLike {
  const gate = createTranslateGate('llm-translate', options, DESCRIPTION)
  if (options.chunkMode && options.chunkMode !== 'shrink') {
    return createChunkedTranslateText(gate, options)
  }
  return gate as TranslateToolLike
}

export const llmTranslate = createLlmTranslate()

export type { GateOutput } from './llm-gate.js'
