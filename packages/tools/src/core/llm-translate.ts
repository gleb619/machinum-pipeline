import { annotate, category, tool, useCase } from '@mt/core'
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
  const result =
    options.chunkMode && options.chunkMode !== 'shrink'
      ? createChunkedTranslateText(gate, options)
      : (gate as TranslateToolLike)
  return annotate(
    result,
    tool('TL051', {
      name: 'llm-translate',
      description: 'Translates text with LLM prompt templates and optional chunking.',
      refs: ['UC059', 'UC060', 'UC061'],
      meta: { alsoCovers: ['TL026'] },
    }),
    useCase('UC060'),
    category(['translator', 'llm']),
  )
}

export const llmTranslate = createLlmTranslate()

export type { GateOutput } from './llm-gate.js'
